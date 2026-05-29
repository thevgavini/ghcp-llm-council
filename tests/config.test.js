const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, loadConfig } = require('../server/lib/config.cjs');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

function valid() {
  return {
    council: [
      { id: 'a', vendor: 'V', display: 'A' },
      { id: 'b', vendor: 'V', display: 'B' }
    ],
    chairman: 'a',
    min_responses_to_proceed: 2,
    councillor_timeout_seconds: 120
  };
}

test('validateConfig accepts a well-formed config', () => {
  assert.equal(validateConfig(valid()).ok, true);
});

test('validateConfig rejects fewer than 2 councillors', () => {
  const c = valid(); c.council = [c.council[0]];
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.match(r.error, /at least 2/);
});

test('validateConfig rejects councillor missing id', () => {
  const c = valid(); delete c.council[1].id;
  assert.equal(validateConfig(c).ok, false);
});

test('validateConfig rejects chairman not in council and not standalone string', () => {
  const c = valid(); c.chairman = 12345;
  assert.equal(validateConfig(c).ok, false);
});

test('validateConfig rejects duplicate councillor ids', () => {
  const c = valid(); c.council[1].id = 'a';
  const r = validateConfig(c);
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate/i);
});

test('validateConfig rejects min_responses_to_proceed greater than council size', () => {
  const c = valid(); c.min_responses_to_proceed = 5;
  assert.equal(validateConfig(c).ok, false);
});

test('loadConfig falls back to defaults when runtime file is absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const defaultsPath = path.join(__dirname, '../defaults/council.json');
  const result = loadConfig({ runtimePath: path.join(tmp, 'missing.json'), defaultsPath });
  assert.ok(Array.isArray(result.council));
  assert.equal(result.source, 'defaults');
});

test('loadConfig uses runtime file when present and valid', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const runtime = path.join(tmp, 'council.json');
  fs.writeFileSync(runtime, JSON.stringify(valid()));
  const defaultsPath = path.join(__dirname, '../defaults/council.json');
  const result = loadConfig({ runtimePath: runtime, defaultsPath });
  assert.equal(result.source, 'runtime');
  assert.equal(result.council.length, 2);
});

test('loadConfig falls back to defaults when runtime file is malformed JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const runtime = path.join(tmp, 'council.json');
  fs.writeFileSync(runtime, '{ not valid json');
  const defaultsPath = path.join(__dirname, '../defaults/council.json');
  const result = loadConfig({ runtimePath: runtime, defaultsPath });
  assert.equal(result.source, 'defaults');
  assert.match(result.warning, /malformed/i);
});
