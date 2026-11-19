/* Servidor de sincronização de uma prova (Desafio de Entrega, Labirinto Inteligente ou Carros Autônomos).
   - Serve o site da prova em "/" (coordenação) e "/#telao" (TV).
   - Guarda o estado da prova e empurra cada mudança na hora para todos os aparelhos (Server-Sent Events).
   - Recebe só o que mudou (patches), para dois árbitros editarem ao mesmo tempo sem apagar um ao outro.
   - Edição protegida por PIN (variável de ambiente PIN); o telão só lê.
   Sem dependências: node server.js */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const MOD = ['labirinto', 'carros'].includes(process.env.MODALIDADE) ? process.env.MODALIDADE : 'entrega';
const PIN = String(process.env.PIN || '');
const PORT = +process.env.PORT || 10000;
const HTML = path.join(__dirname, { entrega: 'Desafio_de_Entrega.html', labirinto: 'Labirinto_Inteligente.html', carros: 'Carros_Autonomos.html' }[MOD]);
const DATA = process.env.DATA_FILE || path.join(require('os').tmpdir(), 'estado-' + MOD + '.json');

let state = null, tv = { modo: 'auto', vista: 'auto' }, rev = 0;
try { const j = JSON.parse(fs.readFileSync(DATA, 'utf8')); state = j.state || null; tv = j.tv || tv; rev = j.rev || 0; } catch (e) {}

/* Cópia no banco Key Value do Render (REDIS_URL): o servidor gratuito dorme e reinicia vazio; ao acordar, lê de lá.
   Cliente mínimo do protocolo Redis (só GET e SET), sem dependências. */
const net = require('net');
const KEY = 'estado-' + MOD;
function kv(cmd) {
  return new Promise((resolve, reject) => {
    const u = process.env.REDIS_URL; if (!u) return resolve(null);
    let url; try { url = new URL(u); } catch (e) { return reject(e); }
    const args = [];
    if (url.password) args.push(['AUTH', ...(url.username && url.username !== 'default' ? [decodeURIComponent(url.username)] : []), decodeURIComponent(url.password)]);
    args.push(cmd);
    const enc = a => '*' + a.length + '\r\n' + a.map(x => { const b = Buffer.from(String(x), 'utf8'); return '$' + b.length + '\r\n' + b.toString('utf8') + '\r\n'; }).join('');
    const sock = (url.protocol === 'rediss:' ? require('tls') : net).connect({ host: url.hostname, port: +url.port || 6379, servername: url.hostname });
    let buf = Buffer.alloc(0), replies = [];
    const done = (e, v) => { try { sock.destroy(); } catch (x) {} e ? reject(e) : resolve(v); };
    sock.setTimeout(8000, () => done(new Error('timeout')));
    sock.on('error', e => done(e));
    sock.on('connect', () => sock.write(args.map(enc).join('')));
    sock.on('secureConnect', () => {});
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (buf.length) {
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const t = String.fromCharCode(buf[0]), line = buf.slice(1, nl).toString('utf8');
        if (t === '$') { const n = +line; if (n < 0) { replies.push(null); buf = buf.slice(nl + 2); } else { if (buf.length < nl + 2 + n + 2) return; replies.push(buf.slice(nl + 2, nl + 2 + n).toString('utf8')); buf = buf.slice(nl + 2 + n + 2); } }
        else { if (t === '-') return done(new Error(line)); replies.push(line); buf = buf.slice(nl + 2); }
        if (replies.length === args.length) return done(null, replies[replies.length - 1]);
      }
    });
  });
}
let kvOk = false, kvT = null;
function kvSave() { if (!process.env.REDIS_URL) return; clearTimeout(kvT); kvT = setTimeout(() => kv(['SET', KEY, JSON.stringify({ state, tv, rev })]).then(() => { kvOk = true; }).catch(e => { kvOk = false; console.error('kv set', e.message); }), 300); }

const clients = new Set();
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(DATA, JSON.stringify({ state, tv, rev }), () => {}), 400); kvSave(); }
function packet() { return `data: ${JSON.stringify({ st: state, tv, rev, now: Date.now() })}\n\n`; }
function broadcast() { const msg = packet(); for (const c of clients) { try { c.write(msg); } catch (e) {} } persist(); }

const BAD = new Set(['__proto__', 'prototype', 'constructor']);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/* patch = [[caminho, valor, apagar?], ...]; caminho [] troca o estado inteiro */
function applyPatch(root, patch) {
  for (const op of patch) {
    if (!Array.isArray(op) || !Array.isArray(op[0])) throw new Error('patch inválido');
    const [p, v, del] = op;
    if (p.some(k => typeof k !== 'string' || BAD.has(k))) throw new Error('caminho inválido');
    if (!p.length) { root = del ? null : v; continue; }
    if (!isObj(root)) throw new Error('sem estado');
    let o = root;
    for (let i = 0; i < p.length - 1; i++) { if (!isObj(o[p[i]])) o[p[i]] = {}; o = o[p[i]]; }
    const k = p[p.length - 1];
    if (del) delete o[k]; else o[k] = v;
  }
  return root;
}
const pinOk = req => { if (!PIN) return true; const a = Buffer.from(String(req.headers['x-pin'] || '')), b = Buffer.from(PIN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function readBody(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', d => { n += d.length; if (n > 8e6) { req.destroy(); return; } chunks.push(d); });
  req.on('end', () => { try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(e); } });
}
function send(res, code, obj, type) {
  const body = type ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return fs.readFile(HTML, (e, buf) => e ? send(res, 500, { erro: 'site não encontrado' }) : send(res, 200, buf, 'text/html; charset=utf-8'));
  }
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, modalidade: MOD, rev, banco: !!process.env.REDIS_URL, bancoOk: kvOk });
  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { st: state, tv, rev, now: Date.now(), pin: !!PIN, modalidade: MOD });
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n' + packet());
    clients.add(res);
    const hb = setInterval(() => { try { res.write(`event: ping\ndata: ${Date.now()}\n\n`); } catch (e) {} }, 10000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/check') return send(res, pinOk(req) ? 200 : 401, { ok: pinOk(req) });
  if (req.method === 'POST' && (url.pathname === '/api/patch' || url.pathname === '/api/tv')) {
    if (!pinOk(req)) return send(res, 401, { erro: 'PIN incorreto' });
    return readBody(req, (e, body) => {
      if (e) return send(res, 400, { erro: 'JSON inválido' });
      if (url.pathname === '/api/tv') {
        const t = body.tv || {};
        tv = { modo: String(t.modo || 'auto').slice(0, 20), vista: String(t.vista || 'auto').slice(0, 20), cv: String(t.cv || 'auto').slice(0, 20) };
        rev++; broadcast(); return send(res, 200, { rev });
      }
      const patch = body.patch;
      if (!Array.isArray(patch) || !patch.length) return send(res, 400, { erro: 'patch vazio' });
      if (!state && !patch.some(op => Array.isArray(op[0]) && !op[0].length)) return send(res, 409, { erro: 'servidor sem estado: envie o estado completo' });
      try { const next = applyPatch(state ? JSON.parse(JSON.stringify(state)) : null, patch); if (next !== null && !isObj(next)) throw new Error('estado inválido'); state = next; }
      catch (err) { return send(res, 400, { erro: err.message }); }
      rev++; broadcast(); send(res, 200, { rev });
    });
  }
  send(res, 404, { erro: 'não encontrado' });
});
/* ao iniciar: se houver cópia no banco mais nova que a local, usa a do banco */
(async () => {
  try { const v = await kv(['GET', KEY]); if (v) { const j = JSON.parse(v); if (j.state && (!state || (j.state.atualizado || 0) >= (state.atualizado || 0))) { state = j.state; tv = j.tv || tv; rev = j.rev || rev; } } kvOk = !!process.env.REDIS_URL; console.log('banco:', process.env.REDIS_URL ? (v ? 'estado carregado' : 'vazio') : 'sem REDIS_URL'); }
  catch (e) { console.error('kv get', e.message); }
  server.listen(PORT, () => console.log(`${MOD} na porta ${PORT}${PIN ? ' (edição com PIN)' : ' (SEM PIN)'}`));
})();
