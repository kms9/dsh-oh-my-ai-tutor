// Standalone workbench harness: serves lib/standalone.js and the same RPC handler the DSH plugin registers.
// Usage: node scripts/workbench-server.mjs --state /path/tutor-state.json [--port 4180]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { JsonTutorStore } from '../src/store.mjs';
import { createRpcHandler, ENDPOINT } from '../src/rpc.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const root = fileURLToPath(new URL('../', import.meta.url));
const statePath = arg('--state', process.env.TUTOR_STATE);
if (!statePath) { console.error('--state is required'); process.exit(2); }
const port = Number(arg('--port', 4180));
const handler = createRpcHandler(new JsonTutorStore(statePath));
const page = `<!doctype html><html lang="zh-CN"><head><link rel="icon" href="data:,"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>oh-my-ai-tutor · 学习工作台</title></head><body><div id="root"></div><script src="/standalone.js"></script></body></html>`;
createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === `/api/${ENDPOINT}`) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const response = await handler(new Request(`http://local${req.url}`, { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }));
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (req.url === '/standalone.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(await readFile(join(root, 'lib/standalone.js'))); return; }
    if (req.url === '/' || req.url.startsWith('/?')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); return; }
    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end(String(e?.message ?? e)); }
}).listen(port, '127.0.0.1', () => console.log(`workbench harness http://127.0.0.1:${port}/ state=${statePath}`));
