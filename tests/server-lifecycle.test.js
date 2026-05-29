const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    stream.on('error', reject);
  });
}

test('server.cjs prints server-started JSON and writes server-info', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const child = spawn(process.execPath, [path.join(__dirname, '../server/server.cjs')], {
    env: { ...process.env, LLM_COUNCIL_DIR: tmp, LLM_COUNCIL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const started = await readJsonLine(child.stdout);
    assert.equal(started.type, 'server-started');
    assert.ok(started.url.startsWith('http://127.0.0.1:'));
    assert.ok(fs.existsSync(path.join(tmp, 'state/server-info')));
    const info = JSON.parse(fs.readFileSync(path.join(tmp, 'state/server-info'), 'utf8'));
    assert.equal(info.port, started.port);
  } finally {
    child.kill();
  }
});

test('server.cjs exits when owner PID dies', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  // Spawn a short-lived "owner" process whose PID we hand to the server.
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  const server = spawn(process.execPath, [path.join(__dirname, '../server/server.cjs')], {
    env: {
      ...process.env,
      LLM_COUNCIL_DIR: tmp,
      LLM_COUNCIL_HOST: '127.0.0.1',
      LLM_COUNCIL_OWNER_PID: String(owner.pid),
      LLM_COUNCIL_LIFECYCLE_INTERVAL_MS: '200'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await readJsonLine(server.stdout);
    owner.kill();
    const code = await new Promise((r) => server.on('exit', r));
    assert.equal(code, 0);
  } finally {
    try { server.kill(); } catch {}
    try { owner.kill(); } catch {}
  }
});
