const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../skills/llm-council/server/lib/http.cjs');

let server, url, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-'));
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

test('GET / serves index.html', async () => {
  const res = await fetch(url + '/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<title>LLM Council<\/title>/);
});

test('GET unknown path returns 404', async () => {
  const res = await fetch(url + '/does-not-exist');
  assert.equal(res.status, 404);
});

test('GET /api/health returns ok and a csrf_token', async () => {
  const res = await fetch(url + '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.csrf_token, /^[0-9a-f]{48}$/);
});

test('listen on port 0 picks a random port', () => {
  assert.ok(server.port > 0);
});
