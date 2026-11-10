import http from 'node:http';
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { applyCommand, emptyWorld, validateWorld, mechanics, WorldError } from './world.mjs';

export async function createWorldServer({dataPath, users, host = '127.0.0.1', port = 4174, onPersistenceSample} = {}) {
  if (!dataPath || typeof dataPath !== 'string') throw new Error('dataPath is required.');
  if (onPersistenceSample !== undefined && typeof onPersistenceSample !== 'function') throw new Error('onPersistenceSample must be a function.');
  if (!users || typeof users !== 'object' || Array.isArray(users) || !Object.keys(users).length) throw new Error('Configure at least one user token.');
  const identities = new Set();
  for (const [token,user] of Object.entries(users)) {
    if (token.length < 16 || !user || typeof user.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(user.id) || !['viewer','builder','admin'].includes(user.role) || identities.has(user.id)) throw new Error('User tokens need 16+ characters, unique safe IDs, and a valid role.');
    identities.add(user.id);
  }
  users = structuredClone(users);
  let state;
  try { state = validateWorld(JSON.parse(await readFile(dataPath,'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') state = emptyWorld(); else throw error; }
  let queue = Promise.resolve();
  const limits = new Map();
  // shortcut: gravity advances on move requests only; add a server tick if falling must continue while disconnected or during server downtime.
  const movementTimes = new Map();
  async function save(next, commandType) {
    await mkdir(path.dirname(dataPath),{recursive:true});
    const temporary = `${dataPath}.${randomUUID()}.tmp`;
    const measure = typeof onPersistenceSample === 'function';
    const started = measure ? performance.now() : 0;
    try {
      const encoded = JSON.stringify(next);
      const serializedAt = measure ? performance.now() : 0;
      await writeFile(temporary,encoded,{flag:'wx',mode:0o600});
      const writtenAt = measure ? performance.now() : 0;
      await rename(temporary,dataPath);
      if (measure) {
        const sample = {commandType,objects:next.objects.length,players:next.players.length,bytes:Buffer.byteLength(encoded),serializeMs:serializedAt-started,writeMs:writtenAt-serializedAt,renameMs:performance.now()-writtenAt};
        // Metrics are advisory and cannot turn a committed write into a failed command.
        try { onPersistenceSample(sample); } catch {}
      }
    } catch(error) { await unlink(temporary).catch(()=>{}); throw error; }
  }
  function json(res,status,value) { res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
  const server = http.createServer(async (req,res) => {
    // Tokens are required even for loopback. No cookie authentication is used.
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
      const actor = Object.hasOwn(users,token) ? users[token] : null;
      if (!actor) throw new WorldError('unauthorized','A valid server-issued token is required.',401);
      const now = Date.now();
      let limit = limits.get(token);
      if (!limit || now-limit.time >= 1000) { limit = {time:now,count:0}; limits.set(token,limit); }
      if (++limit.count > 40) throw new WorldError('rate_limited','Maximum 40 requests per second.',429);
      if (req.url === '/state' && req.method === 'GET') { json(res,200,{...state,mechanics,me:{id:actor.id,role:actor.role}}); return; }
      if (req.url !== '/command' || req.method !== 'POST') throw new WorldError('not_found','Unknown endpoint.',404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new WorldError('invalid_content_type','Use application/json.',415);
      let bytes=0, chunks=[];
      for await (const chunk of req) {
        bytes+=chunk.length;
        if(bytes>16384) throw new WorldError('body_too_large','Maximum command body is 16 KiB.',413);
        chunks.push(chunk);
      }
      let command;
      try { command=JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new WorldError('invalid_json','Malformed JSON.'); }
      const operation = queue.then(async()=>{
        const movedAt=Date.now(), previousMove=movementTimes.get(actor.id);
        const deltaSeconds=command?.type==='move'&&previousMove!==undefined ? Math.min(.25,Math.max(0,(movedAt-previousMove)/1000)) : 0;
        const update = applyCommand(state,actor,command,deltaSeconds);
        await save(update.state,command.type);
        state=update.state;
        if(command?.type==='move')movementTimes.set(actor.id,movedAt);
        return update.result;
      });
      queue = operation.catch(()=>{});
      json(res,200,await operation);
    } catch(error) {
      if (!res.destroyed) json(res,error instanceof WorldError ? error.status : 500,{error:error instanceof WorldError ? error.code : 'storage_error',message:error instanceof WorldError ? error.message : 'The command could not be saved. World state was not changed.'});
    }
  });
  server.requestTimeout=10000;
  server.headersTimeout=10000;
  server.start = async () => {
    await new Promise((resolve,reject)=>{ server.once('error',reject); server.listen(port,host,()=>{server.off('error',reject);resolve();}); });
    return server.address();
  };
  server.shutdown = async () => {
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await queue;
  };
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const world = await createWorldServer({dataPath:process.env.WORLD_DATA_PATH || path.resolve('data/world.json'),users:JSON.parse(process.env.WORLD_USERS_JSON || '{}'),host:process.env.WORLD_HOST || '127.0.0.1',port:Number(process.env.WORLD_PORT || 4174)});
    const address=await world.start();
    console.log(`World server listening on ${address.address}:${address.port}. Never expose unencrypted HTTP to the public Internet.`);
    for (const signal of ['SIGTERM','SIGINT']) process.once(signal,()=>world.shutdown().then(()=>process.exit(0)));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
