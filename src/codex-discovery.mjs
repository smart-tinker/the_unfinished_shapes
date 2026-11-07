import * as nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Layout references: public openai/codex codex-cli/bin/codex.js (main and rust-v0.100.0).
const targets = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
};

/** Read-only candidate discovery. It never starts Codex or reads its profile/history. */
export async function findCodex({platform = process.platform, arch = process.arch, env = process.env, home = homedir(), fs = nativeFs} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  const target = targets[`${platform}-${arch}`];
  const candidates = [], seen = new Set(), attempted = new Set(), packageRoots = new Set();
  let incomplete = false;
  const value = name => String(Object.entries(env).find(([key]) => platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name)?.[1] || '');
  // Automatic discovery accepts drive-qualified Windows paths, never UNC/device namespaces.
  const valid = file => typeof file === 'string' && file.length <= 4096 && !/[\x00-\x1f]/u.test(file) && p.isAbsolute(file) && (platform !== 'win32' || /^[A-Za-z]:[\\/]/u.test(file));
  const key = file => platform === 'win32' ? p.normalize(file).toLowerCase() : p.normalize(file);
  const note = error => { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) incomplete = true; };
  async function exists(file) {
    try { return (await fs.stat(file)).isFile(); } catch (error) { note(error); return false; }
  }
  async function children(directory, pattern, limit = 12) {
    if (!valid(directory)) return [];
    try {
      const entries = await fs.readdir(directory);
      if (entries.length > 256) incomplete = true;
      const matching = entries.slice(0,256).filter(name => typeof name === 'string' && pattern.test(name)).sort().reverse();
      if (matching.length > limit) incomplete = true;
      return matching.slice(0,limit);
    } catch (error) { note(error); return []; }
  }
  async function add(file, source, label) {
    if (!valid(file) || attempted.has(key(file))) return;
    attempted.add(key(file));
    if (candidates.length >= 32) { incomplete = true; return; }
    try {
      if (!(await fs.stat(file)).isFile()) return;
      const resolved = await fs.realpath(file);
      if (!valid(resolved)) return;
      // npm's executable JS entrypoint is not a native Windows process.
      if (/\.(?:cmd|bat|ps1|js|mjs)$/iu.test(resolved)) {
        if (p.basename(resolved).toLowerCase() === 'codex.js' && p.basename(p.dirname(resolved)) === 'bin') {
          await npmPackage(p.dirname(p.dirname(resolved)));
        }
        return;
      }
      if (platform === 'win32') {
        if (!resolved.toLowerCase().endsWith('.exe')) return;
        // Desktop launchers are not the app-server CLI bundled in resources.
        if (await exists(p.join(p.dirname(resolved),'resources','app.asar')) || await exists(p.join(p.dirname(resolved),'resources','codex.exe'))) return;
      } else await fs.access(resolved,constants.X_OK);
      if (seen.has(key(resolved))) return;
      seen.add(key(resolved)); candidates.push({path:resolved,source,label});
    } catch (error) { note(error); }
  }
  async function npmPackage(root) {
    if (!valid(root) || !target || packageRoots.has(key(root))) return;
    packageRoots.add(key(root));
    const platformPackage = `codex-${platform}-${arch}`;
    const roots = [root, p.join(root,'node_modules','@openai',platformPackage),p.join(p.dirname(root),platformPackage)];
    for (const packageRoot of roots) for (const folder of ['bin','codex']) {
      await add(p.join(packageRoot,'vendor',target,folder,executable),'npm','Codex CLI · npm installation');
    }
  }
  async function bin(directory, source = 'standard') {
    if (!valid(directory)) return;
    await add(p.join(directory,executable),source,source === 'path' ? 'Codex CLI · PATH' : 'Codex CLI · standard location');
    await npmPackage(p.join(directory,'node_modules','@openai','codex'));
    await npmPackage(p.join(directory,'..','lib','node_modules','@openai','codex'));
  }
  async function desktop(root) {
    if (!valid(root)) return;
    await add(p.join(root,'resources',executable),'desktop','Codex Desktop · bundled CLI');
    await add(p.join(root,'app','resources',executable),'desktop','Codex Desktop · bundled CLI');
  }
  const pathEntries = value('PATH').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (pathEntries.length > 64) incomplete = true;
  for (const raw of pathEntries.slice(0,64)) {
    const directory = raw.replace(/^"|"$/gu,'');
    await bin(directory,'path');
    if (platform === 'win32') await desktop(directory);
  }
  if (platform === 'win32') {
    const roaming = value('APPDATA'), local = value('LOCALAPPDATA'), programFiles = value('ProgramFiles');
    if (valid(roaming)) await bin(p.join(roaming,'npm'),'npm');
    if (valid(local)) {
      for (const suffix of [['Programs','Codex'],['Codex'],['Programs','OpenAI','Codex'],['OpenAI','Codex'],['Programs','ChatGPT']]) await desktop(p.join(local,...suffix));
      for (const suffix of [['OpenAI','Codex','bin'],['Programs','OpenAI','Codex','bin']]) {
        const root = p.join(local,...suffix);
        await add(p.join(root,executable),'desktop','Codex Desktop · local CLI');
        for (const name of await children(root,/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/u)) await add(p.join(root,name,executable),'desktop','Codex Desktop · versioned CLI');
      }
    }
    if (valid(programFiles)) { await desktop(p.join(programFiles,'Codex')); await desktop(p.join(programFiles,'OpenAI','Codex')); }
  } else {
    for (const directory of ['/usr/local/bin','/usr/bin','/opt/homebrew/bin', ...(valid(home) ? [p.join(home,'.local','bin'),p.join(home,'.npm-global','bin'),p.join(home,'.bun','bin')] : [])]) await bin(directory);
    if (valid(home)) for (const [root,binPath] of [[p.join(home,'.nvm','versions','node'),['bin']],[p.join(home,'.local','share','fnm','node-versions'),['installation','bin']]]) {
      for (const version of await children(root,/^v\d+\.\d+\.\d+$/u)) await bin(p.join(root,version,...binPath));
    }
    if (platform === 'darwin') for (const root of ['/Applications',...(valid(home)?[p.join(home,'Applications')]:[])]) {
      for (const name of ['Codex.app','ChatGPT.app']) await add(p.join(root,name,'Contents','Resources','codex'),'desktop','Codex Desktop · bundled CLI');
    }
  }
  if (valid(home)) for (const folder of ['.vscode','.vscode-insiders','.vscode-server']) {
    const root = p.join(home,folder,'extensions');
    for (const extension of await children(root,/^openai\.chatgpt-[0-9][a-zA-Z0-9._-]{0,100}$/u)) {
      const binaryFolders = platform === 'win32' ? [`win32-${arch}`,`windows-${arch}`] : [`${platform}-${arch}`];
      for (const binaryFolder of binaryFolders) await add(p.join(root,extension,'bin',binaryFolder,executable),'vscode','Codex · VS Code extension CLI');
    }
  }
  const hints = [
    'Search only checks PATH and common installation folders. It does not run Codex or access credentials, configuration or conversations.',
    'Choose a candidate explicitly. Finding a file does not verify its version or app-server compatibility; Connect performs the protocol check.',
  ];
  if (!candidates.length) hints.push('No Codex executable found. Install Codex CLI/Desktop, then search again, or browse to its executable manually.');
  if (platform === 'win32') hints.push('For npm installations choose the native codex.exe, not codex.cmd or the Desktop launcher. Microsoft Store package discovery is not included; browse to the bundled CLI if it is not found.');
  if (incomplete) hints.push('Some paths were inaccessible or search limits were reached. Results may be incomplete; you can choose a path manually.');
  return {candidates,hints,incomplete};
}
