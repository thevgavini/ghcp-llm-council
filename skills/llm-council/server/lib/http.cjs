const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store.cjs');
const { loadConfig, validateConfig } = require('./config.cjs');
const { computeAcceptKey, encodeFrame, OPCODES } = require('./ws.cjs');

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath }) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });
  const store = createStore({ dir: conversationsDir });
  const runtimeConfigPath = path.join(stateDir, 'council.json');
  const eventsPath = path.join(stateDir, 'events');
  const listeners = new Set();

  const wsClients = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/health') return json(res, 200, { ok: true });
      if (req.url.startsWith('/api/')) return route(req, res);
      await staticServe(req, res);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = computeAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    wsClients.add(socket);
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });
  function broadcast(obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    const frame = encodeFrame(OPCODES.TEXT, payload);
    for (const s of wsClients) { try { s.write(frame); } catch {} }
  }
  listeners.add((evt) => broadcast(evt));

  async function route(req, res) {
    const u = req.url; const m = req.method;
    if (m === 'GET' && u === '/api/config') {
      return json(res, 200, loadConfig({ runtimePath: runtimeConfigPath, defaultsPath }));
    }
    if (m === 'PUT' && u === '/api/config') {
      const body = await readJson(req);
      const v = validateConfig(body);
      if (!v.ok) return json(res, 400, { error: v.error });
      fs.writeFileSync(runtimeConfigPath, JSON.stringify(body, null, 2));
      emit({ type: 'config-changed' });
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && u === '/api/conversations') {
      const body = await readJson(req);
      const result = store.createConversation({ question: body.question || '' });
      emit({ type: 'conversation-created', conversation_id: result.id });
      return json(res, 201, result);
    }
    let mt = u.match(/^\/api\/conversations\/([^/]+)\/turns$/);
    if (mt && m === 'POST') {
      const cid = mt[1]; const body = await readJson(req);
      const t = store.appendTurn(cid, { question: body.question || '' });
      emit({ type: 'turn-update', conversation_id: cid, turn_id: t.id });
      return json(res, 201, t);
    }
    mt = u.match(/^\/api\/conversations\/([^/]+)$/);
    if (mt && m === 'GET') {
      const conv = store.getConversation(mt[1]);
      if (!conv) return json(res, 404, { error: 'not found' });
      return json(res, 200, conv);
    }
    if (m === 'GET' && u === '/api/conversations') {
      return json(res, 200, store.listConversations());
    }
    mt = u.match(/^\/api\/turns\/([^/]+)$/);
    if (mt && m === 'PATCH') {
      const tid = mt[1]; const body = await readJson(req);
      const cid = body.conversation_id;
      if (!cid) return json(res, 400, { error: 'conversation_id required' });
      const { conversation_id, ...patch } = body;
      store.patchTurn(cid, tid, patch);
      emit({ type: 'turn-update', conversation_id: cid, turn_id: tid, patch });
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && u === '/api/events') {
      const body = await readJson(req);
      const line = JSON.stringify({ ...body, timestamp: Date.now() }) + '\n';
      fs.appendFileSync(eventsPath, line);
      emit({ type: 'pending-input', payload: body });
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }

  async function staticServe(req, res) {
    const file = req.url === '/' ? '/index.html' : req.url;
    const resolved = path.normalize(path.join(publicDir, file));
    if (!resolved.startsWith(publicDir)) return notFound(res);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  }

  function emit(evt) { for (const l of listeners) l(evt); }
  function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const ctx = { publicDir, stateDir, conversationsDir, defaultsPath };
  function listen(port, host) {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        ctx.port = server.address().port;
        ctx.host = host;
        resolve();
      });
    });
  }
  function close() {
    for (const s of wsClients) { s.destroy(); }
    wsClients.clear();
    return new Promise((r) => server.close(r));
  }

  return new Proxy({ listen, close, server, onEvent, ctx }, {
    get(t, k) { if (k in t) return t[k]; if (k === 'port') return ctx.port; if (k === 'host') return ctx.host; }
  });
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function notFound(res) { res.writeHead(404); res.end('not found'); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = { createHttpServer };
