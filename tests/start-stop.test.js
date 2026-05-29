const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('start.cjs starts server in background and prints server-started JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const result = spawnSync(process.execPath, [path.join(__dirname, '../skills/llm-council/server/start.cjs'), '--dir', tmp], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(info.type, 'server-started');
  assert.ok(fs.existsSync(path.join(tmp, 'state/server-info')));

  // Health check
  const res = await fetch(info.url + '/api/health');
  assert.equal(res.status, 200);

  // Tear down
  const pid = JSON.parse(fs.readFileSync(path.join(tmp, 'state/server.pid'), 'utf8'));
  try { process.kill(pid); } catch {}
});

test('stop.cjs terminates a running server', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch2-'));
  spawnSync(process.execPath, [path.join(__dirname, '../skills/llm-council/server/start.cjs'), '--dir', tmp]);
  const stop = spawnSync(process.execPath, [path.join(__dirname, '../skills/llm-council/server/stop.cjs'), '--dir', tmp], { encoding: 'utf8' });
  assert.equal(stop.status, 0, stop.stderr);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(tmp, 'state/server-info')), false);
});
