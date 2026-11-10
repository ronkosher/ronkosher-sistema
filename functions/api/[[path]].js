// API del sistema Ron Kosher. Corre como Cloudflare Pages Function con una base D1 (binding DB).
// Todo pedido, stock, caja y catálogo se guarda como documento JSON en la tabla `docs`.
// Cada escritura queda además en `log`, que nunca se modifica: es el registro de auditoría.
//
// Acceso: solo entra quien pasó por Cloudflare Access. Se valida la firma del token en cada
// pedido. Si faltan ACCESS_TEAM y ACCESS_AUD, la API no responde datos (falla cerrada).

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_DOC = 900_000; // bytes; D1 admite hasta ~1 MB por valor

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL, por TEXT, PRIMARY KEY (col, id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated)'),
    db.prepare('CREATE TABLE IF NOT EXISTS log (n INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, por TEXT, col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL)'),
  ]);
  schemaReady = true;
}

/* ---------- identidad ---------- */
let certCache = { t: 0, keys: [] };
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function accessEmail(request, env) {
  // Solo para pruebas locales. Nunca definir DEV_EMAIL en Cloudflare.
  if (env.DEV_EMAIL) return env.DEV_EMAIL;
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return { error: 'config' };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64u(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64u(parts[1])));
  } catch { return null; }
  const issuer = `https://${env.ACCESS_TEAM}.cloudflareaccess.com`;
  if (Date.now() - certCache.t > 3600_000 || !certCache.keys.some((k) => k.kid === header.kid)) {
    const r = await fetch(`${issuer}/cdn-cgi/access/certs`);
    if (!r.ok) return null;
    certCache = { t: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) return null;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD) || payload.iss !== issuer) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  return typeof payload.email === 'string' ? payload.email.toLowerCase() : null;
}

async function getDoc(db, col, id) {
  const row = await db.prepare('SELECT data, updated FROM docs WHERE col = ?1 AND id = ?2').bind(col, id).first();
  return row ? { data: JSON.parse(row.data), updated: row.updated } : null;
}

async function whoAmI(db, env, email) {
  const cfg = (await getDoc(db, 'catalogo', 'config'))?.data || {};
  const u = (cfg.usuarios || {})[email] || {};
  const envAdmins = String(env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const nombre = u.nombre || email.split('@')[0];
  const admin = envAdmins.includes(email) || u.rol === 'admin' || (cfg.admins || []).includes(u.nombre);
  return { email, nombre, admin };
}

async function writeDoc(db, col, id, data, por, now) {
  const text = JSON.stringify(data);
  if (text.length > MAX_DOC) throw new Error('Documento demasiado grande');
  const stmts = [
    db.prepare('INSERT INTO docs (col, id, data, updated, por) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (col, id) DO UPDATE SET data = ?3, updated = ?4, por = ?5').bind(col, id, text, now, por),
  ];
  // Las fotos no se repiten en el registro: ocupan mucho y no cambian.
  if (col !== 'fotos') stmts.push(db.prepare('INSERT INTO log (t, por, col, id, data) VALUES (?1, ?2, ?3, ?4, ?5)').bind(now, por, col, id, text));
  await db.batch(stmts);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (!env.DB) return json({ error: 'Falta conectar la base de datos (binding DB).' }, 503);
    const email = await accessEmail(request, env);
    if (email && email.error === 'config') return json({ error: 'Falta configurar el acceso (ACCESS_TEAM y ACCESS_AUD). Por seguridad el sistema no muestra datos hasta que esté configurado.' }, 503);
    if (!email) return json({ error: 'No autorizado. Entrá por la dirección oficial del sistema.' }, 401);
    const db = env.DB;
    await ensureSchema(db);
    const me = await whoAmI(db, env, email);
    const now = Date.now();

    if (path[0] === 'me' && request.method === 'GET') return json(me);

    // Todo lo que cambió desde `since`. Las fotos se piden aparte, de a una.
    if (path[0] === 'sync' && request.method === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      const rs = await db.prepare("SELECT col, id, data, updated FROM docs WHERE updated >= ?1 AND col != 'fotos' ORDER BY updated LIMIT 5000").bind(since).all();
      return json({ now, docs: rs.results.map((r) => ({ col: r.col, id: r.id, data: JSON.parse(r.data), updated: r.updated })) });
    }

    if (path[0] === 'doc' && path.length >= 2 && path.slice(1).every((s) => SEG.test(s))) {
      const col = path[1];
      if (request.method === 'GET' && path.length === 3) {
        const d = await getDoc(db, col, path[2]);
        return json(d ? { exists: true, data: d.data, updated: d.updated } : { exists: false });
      }
      if (request.method === 'PUT' && path.length === 3) {
        const body = await request.json();
        if (!body || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) return json({ error: 'Datos inválidos' }, 400);
        if (col === 'catalogo' && !me.admin) return json({ error: 'Solo un administrador puede cambiar el catálogo o la configuración.' }, 403);
        let data = body.data;
        if (body.merge) {
          const prev = await getDoc(db, col, path[2]);
          if (!prev) return json({ error: 'No existe ese registro' }, 404);
          data = Object.assign({}, prev.data, body.data);
        }
        await writeDoc(db, col, path[2], data, me.nombre, now);
        return json({ ok: true, id: path[2], updated: now });
      }
      if (request.method === 'POST' && path.length === 2) {
        const body = await request.json();
        if (!body || typeof body.data !== 'object' || body.data === null) return json({ error: 'Datos inválidos' }, 400);
        if (col === 'catalogo') return json({ error: 'No permitido' }, 403);
        const id = now.toString(36) + '-' + crypto.randomUUID().slice(0, 8);
        await writeDoc(db, col, id, body.data, me.nombre, now);
        return json({ ok: true, id, updated: now });
      }
    }

    // Carga inicial de catálogos y saldos. Solo administradores.
    if (path[0] === 'import' && request.method === 'POST') {
      if (!me.admin) return json({ error: 'Solo un administrador puede importar datos.' }, 403);
      const body = await request.json();
      const docs = Array.isArray(body?.docs) ? body.docs : [];
      if (!docs.length || docs.length > 2000) return json({ error: 'El archivo no tiene registros o tiene demasiados.' }, 400);
      for (const d of docs) {
        if (!SEG.test(d.col || '') || !SEG.test(d.id || '') || typeof d.data !== 'object' || d.data === null) return json({ error: 'Registro inválido en el archivo: ' + (d.col || '?') + '/' + (d.id || '?') }, 400);
      }
      for (const d of docs) await writeDoc(db, d.col, d.id, d.data, me.nombre, now);
      return json({ ok: true, importados: docs.length });
    }

    // Historial completo de un registro, para auditoría. Solo administradores.
    if (path[0] === 'log' && path.length === 3 && request.method === 'GET') {
      if (!me.admin) return json({ error: 'Solo un administrador puede ver el registro.' }, 403);
      const rs = await db.prepare('SELECT t, por, data FROM log WHERE col = ?1 AND id = ?2 ORDER BY n DESC LIMIT 200').bind(path[1], path[2]).all();
      return json({ cambios: rs.results.map((r) => ({ t: r.t, por: r.por, data: JSON.parse(r.data) })) });
    }

    return json({ error: 'No encontrado' }, 404);
  } catch (e) {
    return json({ error: 'Error del servidor: ' + (e && e.message ? e.message : 'desconocido') }, 500);
  }
}
