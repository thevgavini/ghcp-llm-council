const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../server/lib/http.cjs');

let server, url, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../defaults/council.json')
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

test('GET /api/health returns ok', async () => {
  const res = await fetch(url + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('listen on port 0 picks a random port', () => {
  assert.ok(server.port > 0);
});
