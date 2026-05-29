const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../skills/llm-council/server/lib/http.cjs');

let server, url, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../skills/llm-council/server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../skills/llm-council/defaults/council.json')
  });
  await server.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${server.port}`;
});
after(async () => { await server.close(); });

async function api(method, p, body) {
  const res = await fetch(url + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/config returns defaults when no runtime config exists', async () => {
  const { status, body } = await api('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(body.source, 'defaults');
  assert.ok(Array.isArray(body.council));
});

test('PUT /api/config validates and persists', async () => {
  const valid = {
    council: [
      { id: 'a', vendor: 'V', display: 'A' },
      { id: 'b', vendor: 'V', display: 'B' }
    ],
    chairman: 'a',
    min_responses_to_proceed: 2,
    councillor_timeout_seconds: 60
  };
  const r = await api('PUT', '/api/config', valid);
  assert.equal(r.status, 200);
  const get = await api('GET', '/api/config');
  assert.equal(get.body.source, 'runtime');
  assert.equal(get.body.councillor_timeout_seconds, 60);
});

test('PUT /api/config rejects invalid', async () => {
  const r = await api('PUT', '/api/config', { council: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 2/);
});

test('POST /api/conversations + POST /turns + PATCH /turns', async () => {
  const c = await api('POST', '/api/conversations', { question: 'why?' });
  assert.equal(c.status, 201);
  const cid = c.body.id;

  const t = await api('POST', `/api/conversations/${cid}/turns`, { question: 'why?' });
  assert.equal(t.status, 201);
  const tid = t.body.id;

  const p = await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, stage: 1 });
  assert.equal(p.status, 200);

  const got = await api('GET', `/api/conversations/${cid}`);
  assert.equal(got.body.turns[0].stage, 1);
});

test('GET /api/conversations returns list', async () => {
  const r = await api('GET', '/api/conversations');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

test('POST /api/events appends to events file', async () => {
  const r = await api('POST', '/api/events', { type: 'follow-up', question: 'and?' });
  assert.equal(r.status, 200);
  const eventsFile = path.join(tmp, 'state/events');
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.type, 'follow-up');
});
