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

const clients = new Set();
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => fs.writeFile(DATA, JSON.stringify({ state, tv, rev }), () => {}), 400); }
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
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, modalidade: MOD, rev });
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
server.listen(PORT, () => console.log(`${MOD} na porta ${PORT}${PIN ? ' (edição com PIN)' : ' (SEM PIN)'}`));
