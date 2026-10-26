import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const snapshot = JSON.parse(await readFile(path.join(root, 'live-snapshot.json'), 'utf8').then(s => s.replace(/^\uFEFF/, '')));
const allowed = new Set(snapshot.files.map(f => '/' + f.path));
const productionFunctions = 'https://us-central1-lexivoice-27fc1.cloudfunctions.net';
const localFunctions = 'http://127.0.0.1:5008/demo-lexivoice/us-central1';
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://www.gstatic.com; style-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:8088 http://localhost:8088 ws://127.0.0.1:8088 ws://localhost:8088 http://127.0.0.1:5008; img-src 'self' data:; media-src 'self' blob:; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
  catch { res.writeHead(400).end(); return; }
  if (pathname === '/') pathname = '/index.html';
  if (!allowed.has(pathname)) { res.writeHead(404).end('Not found'); return; }
  try {
    let body = await readFile(path.join(root, pathname.slice(1)), 'utf8');
    body = body.replaceAll(productionFunctions, localFunctions);
    if (pathname === '/firebase-config.js') {
      body = body.replaceAll('lexivoice-27fc1', 'demo-lexivoice');
      body += '\nwindow.firebaseDb.useEmulator("127.0.0.1", 8088);\nfirebase.functions().useEmulator("127.0.0.1", 5008);\n';
    }
    if (pathname === '/core/webrtc-call.js') {
      body = body.replace('return "https://lexivoice-27fc1.web.app";', 'return window.location.origin;');
    }
    if (pathname.endsWith('.html')) {
      body = body.replace('<body>', '<body><div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#78350f;color:white;padding:8px;text-align:center;font:14px sans-serif">Lokal forhåndsvisning · Produktionsbackend er afskåret · Samtaler og oversættelse kræver lokale emulatorer</div>');
    }
    res.setHeader('Content-Type', pathname.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    res.writeHead(200).end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500).end('Could not read snapshot file');
  }
});
server.listen(5178, '127.0.0.1', () => console.log('LexiVoice local preview: http://127.0.0.1:5178'));
