const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./store.cjs');
const { loadConfig, validateConfig } = require('./config.cjs');
const { computeAcceptKey, encodeFrame, OPCODES } = require('./ws.cjs');

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_BODY_BYTES = 1024 * 1024;   // 1 MiB cap per request body
const ID_RE = /^(conv|turn)_[0-9a-f]{12}$/;

function createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath, csrfToken: providedToken }) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });
  const store = createStore({ dir: conversationsDir });
  const runtimeConfigPath = path.join(stateDir, 'council.json');
  const eventsPath = path.join(stateDir, 'events');
  const listeners = new Set();
  // Per-launch CSRF token. Same-origin pages read it from /api/health and
  // echo it back as X-Council-Token on mutating requests. Cross-origin
  // pages cannot read it.
  const csrfToken = providedToken || crypto.randomBytes(24).toString('hex');

  const wsClients = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      // Enforce same-origin on every mutating REST request.
      if (req.url.startsWith('/api/') && !SAFE_METHODS.has(req.method)) {
        if (!checkOrigin(req)) return json(res, 403, { error: 'forbidden: bad origin' });
        if (!checkContentType(req)) return json(res, 415, { error: 'forbidden: Content-Type must be application/json' });
        if (!checkCsrfToken(req, csrfToken)) return json(res, 403, { error: 'forbidden: missing or invalid X-Council-Token' });
        // M1: cheap upfront check on Content-Length so giant bodies are
        // rejected before we touch the socket data stream. The streaming
        // cap in readJson() remains as defence-in-depth for chunked bodies.
        const cl = Number(req.headers['content-length'] || 0);
        if (cl > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify({ error: 'request body too large' }));
          // Drain incoming bytes so the client gets the response before RST.
          req.on('data', () => {}); req.on('end', () => {}); req.on('error', () => {});
          return;
        }
      }
      if (req.url === '/api/health') return json(res, 200, { ok: true, csrf_token: csrfToken });
      if (req.url.startsWith('/api/')) return route(req, res);
      await staticServe(req, res);
    } catch (e) {
      try { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } catch {}
    }
  });

  server.on('upgrade', (req, socket) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    if (!checkOrigin(req)) { socket.destroy(); return; }
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

  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;  // non-browser clients (curl, node) don't set Origin
    const host = req.headers.host;
    if (!host) return false;
    // Compare scheme-less host. We bind 127.0.0.1 by default, and we want
    // to accept localhost as well as the literal bind address.
    const allowed = [
      `http://${host}`,
      `http://127.0.0.1:${host.split(':')[1] || ''}`.replace(/:$/, ''),
      `http://localhost:${host.split(':')[1] || ''}`.replace(/:$/, '')
    ];
    return allowed.includes(origin);
  }

  function checkContentType(req) {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    return ct.startsWith('application/json');
  }
  function checkCsrfToken(req, expected) {
    return req.headers['x-council-token'] === expected;
  }
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
      // Strip read-only metadata fields that may have round-tripped from GET /api/config.
      const { source, warning, ...persistable } = body;
      fs.writeFileSync(runtimeConfigPath, JSON.stringify(persistable, null, 2));
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
      const cid = mt[1];
      if (!ID_RE.test(cid)) return json(res, 400, { error: 'invalid conversation id' });
      const body = await readJson(req);
      const t = store.appendTurn(cid, { question: body.question || '' });
      emit({ type: 'turn-update', conversation_id: cid, turn_id: t.id });
      return json(res, 201, t);
    }
    mt = u.match(/^\/api\/conversations\/([^/]+)$/);
    if (mt && m === 'GET') {
      const cid = mt[1];
      if (!ID_RE.test(cid)) return json(res, 400, { error: 'invalid conversation id' });
      const conv = store.getConversation(cid);
      if (!conv) return json(res, 404, { error: 'not found' });
      return json(res, 200, conv);
    }
    if (m === 'GET' && u === '/api/conversations') {
      return json(res, 200, store.listConversations());
    }
    mt = u.match(/^\/api\/turns\/([^/]+)$/);
    if (mt && m === 'PATCH') {
      const tid = mt[1];
      if (!ID_RE.test(tid)) return json(res, 400, { error: 'invalid turn id' });
      const body = await readJson(req);
      const cid = body.conversation_id;
      if (!cid || !ID_RE.test(cid)) return json(res, 400, { error: 'conversation_id required and must be a valid id' });
      const { conversation_id, ...patch } = body;
      try {
        store.patchTurn(cid, tid, patch);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
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
    // H3 fix: prefix check needs trailing separator to prevent sibling-dir escape
    // (e.g. publicDir + '-evil' would otherwise pass startsWith(publicDir)).
    if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) return notFound(res);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  }

  function emit(evt) { for (const l of listeners) l(evt); }
  function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const ctx = { publicDir, stateDir, conversationsDir, defaultsPath, csrfToken };
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
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'port') return ctx.port;
      if (k === 'host') return ctx.host;
      if (k === 'csrfToken') return ctx.csrfToken;
    }
  });
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function notFound(res) { res.writeHead(404); res.end('not found'); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const safeResolve = (v) => { if (!settled) { settled = true; resolve(v); } };
    const safeReject = (e) => { if (!settled) { settled = true; reject(e); } };
    req.on('error', safeReject);
    req.on('close', () => safeReject(new Error('request closed prematurely')));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return safeResolve({});
      try { safeResolve(JSON.parse(raw, sanitizeJsonReviver)); } catch (e) { safeReject(e); }
    });
    req.on('data', (c) => {
      if (settled) return;
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        safeReject(new Error('request body too large'));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(c);
    });
  });
}

// H4 (partial): defuse __proto__ / constructor / prototype keys at JSON parse time.
// Prevents an attacker from rewriting an object's prototype via patch fields.
function sanitizeJsonReviver(key, value) {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

module.exports = { createHttpServer };
