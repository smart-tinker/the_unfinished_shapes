import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_LINE = 8 * 1024 * 1024;
const active = (thread) => thread?.status?.type === 'active';

const positionSchema = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'], additionalProperties: false };
export const WORLD_TOOLS = [
  { type: 'function', name: 'world_state', description: 'Read the connected game world, supported mechanics, player identity and role. Never returns credentials.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'world_command', description: 'Perform a user-requested in-game action. Server checks identity, role, ownership and coordinates. Unknown mechanics require repository development and CI, not a bypass.', inputSchema: {
    type: 'object', properties: { command: { oneOf: [
      { type: 'object', properties: { type: { const: 'move' }, position: positionSchema }, required: ['type', 'position'], additionalProperties: false },
      { type: 'object', properties: { type: { const: 'build' }, objectType: { type: 'string', enum: ['block', 'bridge', 'port'] }, position: positionSchema, size: positionSchema, color: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' } }, required: ['type', 'objectType', 'position'], additionalProperties: false },
      { type: 'object', properties: { type: { const: 'remove' }, id: { type: 'string' } }, required: ['type', 'id'], additionalProperties: false },
    ] } }, required: ['command'], additionalProperties: false,
  } },
];
export function toolResult(success, value) {
  return { success: Boolean(success), contentItems: [{ type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

/** Local Codex transport only: no model loop, credentials, or session-file access. */
export class CodexBridge extends EventEmitter {
  constructor({ spawnProcess = spawn, timeoutMs = 30_000 } = {}) {
    super();
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.approvals = new Set();
    this.sequence = 0;
    this.generation = 0;
    this.process = null;
    this.threadId = null;
    this.turnId = null;
    this.sending = false;
  }

  async start({ codexPath, workspacePath, threadId, env = {}, newGameThread = false } = {}) {
    if (this.process || this.starting) throw new Error('Codex is already connected or connecting.');
    this.starting = true;
    const generation = this.generation;
    try {
      if (typeof codexPath !== 'string' || !isAbsolute(codexPath)) throw new Error('Choose an absolute path to the Codex executable.');
      if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) throw new Error('Choose an absolute workspace path.');
      if (!(await stat(codexPath)).isFile()) throw new Error('Codex path must be a file.');
      await access(codexPath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      this.workspacePath = await realpath(workspacePath);
      if (!(await stat(this.workspacePath)).isDirectory()) throw new Error('Workspace must be a directory.');
      if (threadId !== undefined && (typeof threadId !== 'string' || !threadId.trim())) throw new Error('Invalid thread ID.');
      if (generation !== this.generation) throw new Error('Codex connection cancelled.');
      const child = this.spawnProcess(codexPath, ['app-server'], {
        env: { ...process.env, ...Object.fromEntries(Object.entries(env).filter(([key, value]) => ['TUS_WORLD_URL', 'TUS_WORLD_TOKEN'].includes(key) && typeof value === 'string')) },
        cwd: this.workspacePath, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
      this.process = child;
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (this.process !== child) return;
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > MAX_LINE) return this.fail(new Error('Codex response exceeded the size limit.'));
          if (line) {
            try { this.receive(JSON.parse(line)); }
            catch { return this.fail(new Error('Codex returned malformed protocol data.')); }
          }
        }
        if (buffer.length > MAX_LINE) this.fail(new Error('Codex response exceeded the size limit.'));
      });
      // Drain stderr, but never forward unfiltered diagnostics (they may contain secrets).
      child.stderr.on('data', () => {});
      child.stdin.on('error', () => { if (this.process === child) this.fail(new Error('Codex input stream closed.')); });
      child.on('error', () => { if (this.process === child) this.fail(new Error('Could not start the Codex executable.')); });
      child.on('exit', (code) => { if (this.process === child) this.fail(new Error(`Codex exited (${code ?? 'signal'}).`)); });
      await this.request('initialize', { clientInfo: { name: 'the_unfinished_shapes', title: 'The Unfinished Shapes', version: '0.1.0-rc.2' }, capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
      let selected;
      if (threadId && !newGameThread) {
        selected = (await this.request('thread/read', { threadId, includeTurns: false })).thread;
        if (!selected || selected.cwd !== this.workspacePath) throw new Error('Saved conversation belongs to a different workspace.');
        if (active(selected)) throw new Error('Saved conversation has an active turn. Wait for it to finish.');
      } else if (!newGameThread) {
        let cursor;
        const seen = new Set();
        do {
          const page = await this.request('thread/list', { cwd: this.workspacePath, sortKey: 'updated_at', sortDirection: 'desc', sourceKinds: ['cli', 'vscode', 'appServer'], limit: 50, ...(cursor ? { cursor } : {}) });
          if (!Array.isArray(page.data)) throw new Error('Codex returned an invalid conversation list.');
          selected = page.data.find((t) => t.cwd === this.workspacePath && !active(t) && t.status?.type !== 'systemError');
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Codex returned a repeating pagination cursor.');
          seen.add(cursor);
        } while (!selected && cursor);
        if (selected) throw new Error('An existing conversation cannot gain game tools. Select New game conversation explicitly; the original conversation will be preserved.');
      }
      const result = selected
        ? await this.request('thread/resume', { threadId: selected.id, excludeTurns: true, cwd: this.workspacePath, sandbox: 'workspace-write', approvalPolicy: 'on-request' })
        : await this.request('thread/start', { dynamicTools: WORLD_TOOLS, cwd: this.workspacePath, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
      if (!result.thread?.id) throw new Error('Codex did not return a conversation ID.');
      if (active(result.thread)) throw new Error('Conversation became active; not taking over its turn.');
      this.threadId = result.thread.id;
      this.emit('event', { type: 'connected', threadId: this.threadId, workspacePath: this.workspacePath, resumed: Boolean(selected) });
      return { threadId: this.threadId, workspacePath: this.workspacePath, resumed: Boolean(selected), thread: result.thread };
    } catch (error) {
      this.stop();
      throw error;
    } finally { this.starting = false; }
  }

  async send(text) {
    if (!this.threadId || !this.process) throw new Error('Connect Codex first.');
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw new Error('Enter a message of 1–100,000 characters.');
    if (this.turnId || this.sending) throw new Error('A turn is already running.');
    this.sending = true;
    try {
      const result = await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }] });
      if (!result.turn?.id) throw new Error('Codex did not return a turn ID.');
      // A very short turn may complete before its start response arrives.
      if (result.turn.status === 'inProgress' && this.lastCompletedTurnId !== result.turn.id) this.turnId = result.turn.id;
      return result;
    } finally { this.sending = false; }
  }

  async interrupt() {
    if (!this.threadId || !this.turnId) return false;
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
    return true;
  }

  respond(id, result) {
    if (!this.approvals.has(id)) throw new Error('This Codex request is no longer pending.');
    if (result === undefined || result === null || typeof result !== 'object') throw new Error('A structured response is required.');
    this.write({ id, result });
    this.approvals.delete(id);
  }

  request(method, params) {
    if (!this.process) return Promise.reject(new Error('Codex is disconnected.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
        // A timeout leaves the outcome unknown. Disconnect rather than retry a turn.
        this.fail(new Error('Codex stopped responding. Reconnect and inspect the conversation.'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  write(message) {
    if (!this.process?.stdin.writable) throw new Error('Codex is disconnected.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid JSON-RPC message.');
    if (message.method) {
      if ('id' in message) {
        this.approvals.add(message.id);
        if (message.method === 'item/tool/call') {
          const params = message.params ?? {};
          if (!WORLD_TOOLS.some(tool => tool.name === params.tool) || params.namespace || params.threadId !== this.threadId || (!this.turnId && !this.sending) || (this.turnId && params.turnId !== this.turnId)) {
            this.respond(message.id, toolResult(false, 'Tool call is not authorized for the active game turn.'));
          } else {
            this.emit('event', { type: 'tool', id: message.id, name: params.tool, arguments: params.arguments, threadId: params.threadId, turnId: params.turnId });
          }
        } else {
          this.emit('event', { type: 'approval', id: message.id, method: message.method, params: message.params });
        }
      } else {
        const { method, params } = message;
        if (params?.threadId === this.threadId) {
          if (method === 'turn/started') this.turnId = params.turn?.id ?? this.turnId;
          if (method === 'turn/completed') { this.turnId = null; this.lastCompletedTurnId = params.turn?.id; }
        }
        this.emit('event', { type: 'notification', method, params });
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`Codex request failed (${message.error.code ?? 'unknown'}): ${message.error.message ?? 'Unknown error'}`));
    else if ('result' in message) pending.resolve(message.result);
    else pending.reject(new Error('Codex response has no result.'));
  }

  fail(error) {
    this.stop(error);
    this.emit('event', { type: 'disconnected', message: error.message });
  }

  stop(error = new Error('Codex disconnected.')) {
    this.generation += 1;
    const child = this.process;
    this.process = null;
    this.threadId = null;
    this.turnId = null;
    this.approvals.clear();
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
    if (child) { child.stdin.end(); child.kill(); }
  }
}
