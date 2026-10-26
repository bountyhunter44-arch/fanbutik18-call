import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, validateConfig, validateMessage, classifyLocally, routeIntent, validateOutbound, outboundGreeting } from './core.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const statePath = path.join(root, '.local', 'state.json');
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { config: defaultConfig, calls: [] }; }
let queue = Promise.resolve();
async function save(nextState) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath + '.tmp', JSON.stringify(nextState, null, 2), 'utf8');
  await rename(statePath + '.tmp', statePath);
  state = nextState;
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data)); }
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 20000) throw new Error('Beskeden er for stor.'); }
  return JSON.parse(data);
}
export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const hostname = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostname)) { json(res, 403, { error: 'Kun lokal adgang.' }); return; }
    if (req.headers.origin && req.headers.origin !== `http://${hostname}`) { json(res, 403, { error: 'Ugyldig oprindelse.' }); return; }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, { ...state, mode: 'local', ai: 'rules' }); return; }
    if (req.method === 'POST' && ['/api/config', '/api/simulate', '/api/resolve', '/api/outbound-preview'].includes(url.pathname)) {
      try {
        if (!String(req.headers['content-type']).startsWith('application/json')) { json(res, 415, { error: 'JSON kræves.' }); return; }
        const input = await body(req);
        const operation = queue.then(async () => {
          if (url.pathname === '/api/config') {
            const config = validateConfig(input);
            await save({ ...state, config });
            return { config };
          }
          if (url.pathname === '/api/resolve') {
            const target = state.calls.find(call => call.id === input.id);
            if (!target) throw new Error('Opkaldet blev ikke fundet.');
            await save({ ...state, calls: state.calls.map(call => call.id === input.id ? { ...call, resolved: true } : call) });
            return { ok: true };
          }
          if (url.pathname === '/api/outbound-preview') {
            const outbound = validateOutbound(input);
            const call = { id: outbound.requestId, createdAt: new Date().toISOString(), to: outbound.to, message: outbound.purpose,
              reply: outboundGreeting(state.config, outbound.purpose), direction: 'outbound', channel: 'whatsapp', status: 'outbound_preview', mode: 'simulation', resolved: false };
            await save({ ...state, calls: [call, ...state.calls].slice(0, 200) });
            return { call };
          }
          const message = validateMessage(input.message);
          const result = routeIntent(classifyLocally(message), state.config);
          const call = { id: randomUUID(), createdAt: new Date().toISOString(), message, ...result, mode: 'simulation', resolved: false };
          await save({ ...state, calls: [call, ...state.calls].slice(0, 200) });
          return { call };
        });
        queue = operation.catch(() => {});
        json(res, 200, await operation);
      } catch (error) { json(res, 400, { error: error.message }); }
      return;
    }
    const files = { '/': 'index.html', '/index.html': 'index.html', '/app.mjs': 'app.mjs', '/style.css': 'style.css' };
    if (req.method !== 'GET' || !files[url.pathname]) { json(res, 404, { error: 'Ikke fundet.' }); return; }
    const type = url.pathname.endsWith('.mjs') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html';
    try { res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(await readFile(path.join(root, 'public', files[url.pathname]))); }
    catch { json(res, 500, { error: 'Siden kunne ikke indlæses.' }); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer().listen(Number(process.env.PORT || 5180), '127.0.0.1', () => console.log('LexiVoice Business: http://127.0.0.1:5180'));
}
