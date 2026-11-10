// Servidor local de prueba: sirve public/ y ejecuta la API contra SQLite en memoria.
// Uso: DEV_EMAIL=alguien@ejemplo.com node test/server.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../functions/api/[[path]].js';

const sql = new DatabaseSync(':memory:');
const stmt = (q, args = []) => ({
  bind: (...a) => stmt(q, a),
  first: async () => sql.prepare(q.replace(/\?\d+/g, (m) => m)).get(...expand(q, args)) ?? null,
  all: async () => ({ results: sql.prepare(q).all(...expand(q, args)) }),
  run: async () => { sql.prepare(q).run(...expand(q, args)); return {}; },
});
// D1 usa ?1 ?2 reutilizables; node:sqlite también los admite como parámetros numerados.
const expand = (q, args) => args;
const DB = { prepare: (q) => stmt(q), batch: async (list) => { for (const s of list) await s.run(); return []; } };
const env = { DB, DEV_EMAIL: process.env.DEV_EMAIL || 'prueba@ejemplo.com', ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'prueba@ejemplo.com' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await onRequest({ env, request: new Request(url, { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }) });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(await r.text()); return;
  }
  try {
    const f = url.pathname === '/' ? '/index.html' : url.pathname;
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/json' });
    res.end(await readFile(new URL('../public' + f, import.meta.url)));
  } catch { res.writeHead(404); res.end('no'); }
}).listen(process.env.PORT || 8788, () => console.log('listo'));
