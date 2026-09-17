#!/usr/bin/env node
// Consumer smoke for the MCP adapter, run before `npm publish` in mcp/: spawns the
// staged `mcp/src/index.js` and speaks JSON-RPC over stdio to it the way a client
// does, against the live server in VAULT_API_URL. Checks what a publish ships —
// the tool list against what `registerTools` declares (never a count), the
// handshake, `vault_health`, one read tool, and one `fields=` subset.
//   node scripts/mcp-smoke.mjs [--project NAME]
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {VaultClient} from '../mcp/src/client.js';
import {registerTools} from '../mcp/src/tools.js';

const usage = () => {
  console.error('usage: node scripts/mcp-smoke.mjs [--project NAME]');
  process.exit(2);
};
const args = process.argv.slice(2);
let project = 'vault-storage';
for (let i = 0; i < args.length; ++i) {
  if (args[i] === '--project' && args[i + 1]) project = args[++i];
  else usage();
}
const {VAULT_API_URL: apiUrl, VAULT_API_TOKEN: apiToken} = process.env;
if (!apiUrl || !apiToken) {
  console.error('mcp-smoke: VAULT_API_URL and VAULT_API_TOKEN must be set');
  process.exit(2);
}

// The tool names the staged code declares — the same source the adapter loads.
const expected = new Set();
registerTools(
  {registerTool: name => expected.add(name)},
  new VaultClient({apiUrl, apiToken, fetchImpl: () => Promise.resolve(new Response('{}'))})
);

const entry = fileURLToPath(new URL('../mcp/src/index.js', import.meta.url));
const child = spawn(process.execPath, [entry], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit']
});
const pending = new Map();
let nextId = 1;
createInterface({input: child.stdout}).on('line', line => {
  if (line.trim().length === 0) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
  else p.resolve(msg.result);
});
const send = message => child.stdin.write(JSON.stringify({jsonrpc: '2.0', ...message}) + '\n');
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {resolve, reject});
    send({id, method, params});
  });
const call = async (name, callArgs) => {
  const r = await request('tools/call', {name, arguments: callArgs});
  const text = r.content?.[0]?.text ?? '';
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures.push(label);
};
const finish = () => {
  child.stdin.end();
  child.kill();
  console.log(
    failures.length > 0 ? `mcp-smoke: ${failures.length} failed` : 'mcp-smoke: all checks passed'
  );
  process.exit(failures.length > 0 ? 1 : 0);
};
const timer = setTimeout(() => {
  check(false, 'timed out after 20 s');
  finish();
}, 20_000);

try {
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: {name: 'mcp-smoke', version: '0'}
  });
  const server = init.serverInfo ?? {};
  check(
    typeof server.version === 'string',
    `initialize: ${server.name} ${server.version}, protocol ${init.protocolVersion}`
  );
  send({method: 'notifications/initialized', params: {}});

  const listed = new Set((await request('tools/list', {})).tools.map(t => t.name));
  const missing = [...expected].filter(n => !listed.has(n));
  const extra = [...listed].filter(n => !expected.has(n));
  check(
    missing.length === 0 && extra.length === 0,
    `tools/list: ${listed.size} tools, the set registerTools declares` +
      (missing.length > 0 ? `; missing ${missing.join(', ')}` : '') +
      (extra.length > 0 ? `; extra ${extra.join(', ')}` : '')
  );

  const health = await call('vault_health', {});
  check(health.ok === true, `vault_health: ok=${health.ok} stalled=${health.stalled}`);

  const section = await call('vault_read_section', {
    path: `projects/${project}/queue.md`,
    heading: '## Active'
  });
  check(
    section.heading === '## Active' && typeof section.content === 'string',
    `vault_read_section: ${section.path} ${section.heading}, ${section.content?.length ?? 0} bytes`
  );

  const top = await call('vault_queue_top', {limit: 3, fields: 'title'});
  const items = top.items ?? [];
  check(
    items.length > 0 && items.every(i => typeof i.title === 'string' && !('body' in i)),
    `vault_queue_top fields=title: ${items.length} items, keys ${[...new Set(items.flatMap(i => Object.keys(i)))].join(',')}`
  );
} catch (err) {
  check(false, err instanceof Error ? err.message : String(err));
} finally {
  clearTimeout(timer);
  finish();
}
