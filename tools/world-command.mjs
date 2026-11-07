#!/usr/bin/env node
// Run only when a player asks for a world action. Never print the access token.
const base = process.env.TUS_WORLD_URL;
const token = process.env.TUS_WORLD_TOKEN;
try {
  if (!base || !token) throw new Error('Launch this tool through the game to receive the world connection.');
  const url = new URL(base);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid world URL.');
  const argument = process.argv[2];
  if (!argument) throw new Error('Usage: node tools/world-command.mjs state | \'{"type":"build","objectType":"block","position":{"x":0,"y":1,"z":0}}\'');
  const read = argument === 'state';
  const body = read ? undefined : JSON.stringify(JSON.parse(argument));
  const response = await fetch(new URL(read ? '/state' : '/command', url),{
    method:read ? 'GET' : 'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,signal:AbortSignal.timeout(10000)
  });
  const result = await response.json();
  console.log(JSON.stringify(result,null,2));
  if (!response.ok) process.exitCode=1;
} catch(error) { console.error(error instanceof SyntaxError ? 'Invalid JSON command.' : error.message); process.exitCode=1; }
