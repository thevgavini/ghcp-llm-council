// Tests that prove the security review findings are actually blocked.
// Each test reproduces an attack scenario and asserts the server rejects it.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { createHttpServer } = require('../skills/llm-council/server/lib/http.cjs');

let server, url, tmp, token;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../skills/llm-council/server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../skills/llm-council/defaults/council.json')
  });
  await server.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${server.port}`;
  token = (await (await fetch(`${url}/api/health`)).json()).csrf_token;
});
after(async () => { await server.close(); });

// C3 — CSRF: POST without token fails
test('C3: POST without CSRF token is rejected', async () => {
  const res = await fetch(`${url}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'x' })
  });
  assert.equal(res.status, 403);
});

// C3 — CSRF: cross-origin POST is rejected even with content-type and a token attempt
test('C3: POST with foreign Origin header is rejected', async () => {
  const res = await fetch(`${url}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'https://evil.example.com', 'X-Council-Token': token },
    body: JSON.stringify({ question: 'x' })
  });
  assert.equal(res.status, 403);
});

// C3 — Content-Type enforcement
test('C3: POST with text/plain Content-Type is rejected', async () => {
  const res = await fetch(`${url}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'X-Council-Token': token },
    body: JSON.stringify({ question: 'x' })
  });
  assert.equal(res.status, 415);
});

// H2 — Invalid cid/tid rejected (no path traversal)
test('H2: GET /api/conversations/<traversal> is rejected', async () => {
  const res = await fetch(`${url}/api/conversations/..%5C..%5Csomething`);
  assert.equal(res.status, 400);
});

test('H2: GET /api/conversations/<garbage> is rejected', async () => {
  const res = await fetch(`${url}/api/conversations/not-an-id`);
  assert.equal(res.status, 400);
});

test('H2: PATCH /api/turns/<garbage> is rejected', async () => {
  const res = await fetch(`${url}/api/turns/not-a-tid`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: JSON.stringify({ conversation_id: 'conv_aaaaaaaaaaaa', stage: 1 })
  });
  assert.equal(res.status, 400);
});

// H4 — patchTurn allowlist + __proto__ defuse
test('H4: PATCH with unexpected field is rejected', async () => {
  const c = await (await fetch(`${url}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: JSON.stringify({ question: 'x' })
  })).json();
  const t = await (await fetch(`${url}/api/conversations/${c.id}/turns`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: JSON.stringify({ question: 'x' })
  })).json();
  const res = await fetch(`${url}/api/turns/${t.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: JSON.stringify({ conversation_id: c.id, evil_field: 'pwned' })
  });
  assert.equal(res.status, 400);
});

test('H4: __proto__ in body is stripped by JSON reviver', async () => {
  const c = await (await fetch(`${url}/api/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: JSON.stringify({ question: 'x' })
  })).json();
  const t = await (await fetch(`${url}/api/conversations/${c.id}/turns`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: JSON.stringify({ question: 'x' })
  })).json();
  // This body would normally rewrite the object's prototype.
  const res = await fetch(`${url}/api/turns/${t.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
    body: '{"conversation_id":"' + c.id + '","__proto__":{"polluted":1},"stage":1}'
  });
  // The reviver stripped __proto__, so the patch becomes {conversation_id, stage}.
  // stage is in the allowlist, so the PATCH succeeds without pollution.
  assert.equal(res.status, 200);
  assert.equal(({}).polluted, undefined);
});

// M1 — body size cap
test('M1: oversized body (>1 MiB) is rejected', async () => {
  const giant = 'x'.repeat(2 * 1024 * 1024);
  let rejected = false;
  try {
    const res = await fetch(`${url}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Council-Token': token },
      body: JSON.stringify({ question: giant })
    });
    rejected = res.status >= 400;
  } catch (e) {
    rejected = true;
  }
  assert.ok(rejected, 'server should not have accepted a 2 MiB body');
  // Give the server time to settle the destroyed request before the test ends,
  // so node:test doesn't flag stray async activity from the before() hook.
  await new Promise((r) => setTimeout(r, 50));
});

// C2 — WS upgrade with bad Origin rejected
test('C2: WS upgrade with foreign Origin is rejected (socket destroyed)', async () => {
  await new Promise((resolve, reject) => {
    const socket = net.connect(server.port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: https://evil.example.com\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      let resolved = false;
      socket.on('data', (chunk) => {
        if (chunk.toString().includes('101')) { reject(new Error('handshake should not have succeeded')); resolved = true; }
      });
      socket.on('close', () => { if (!resolved) resolve(); });
      socket.on('error', () => { if (!resolved) resolve(); });
    });
  });
});

test('C2: WS upgrade with no Origin (non-browser client) succeeds', async () => {
  await new Promise((resolve, reject) => {
    const socket = net.connect(server.port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      socket.on('data', (chunk) => {
        if (chunk.toString().includes('101')) { socket.end(); resolve(); }
      });
      socket.on('close', () => reject(new Error('closed without 101')));
      socket.on('error', reject);
    });
  });
});
