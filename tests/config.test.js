const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig, loadConfig } = require('../skills/llm-council/server/lib/config.cjs');
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
  const defaultsPath = path.join(__dirname, '../skills/llm-council/defaults/council.json');
  const result = loadConfig({ runtimePath: path.join(tmp, 'missing.json'), defaultsPath });
  assert.ok(Array.isArray(result.council));
  assert.equal(result.source, 'defaults');
});

test('loadConfig uses runtime file when present and valid', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const runtime = path.join(tmp, 'council.json');
  fs.writeFileSync(runtime, JSON.stringify(valid()));
  const defaultsPath = path.join(__dirname, '../skills/llm-council/defaults/council.json');
  const result = loadConfig({ runtimePath: runtime, defaultsPath });
  assert.equal(result.source, 'runtime');
  assert.equal(result.council.length, 2);
});

test('loadConfig falls back to defaults when runtime file is malformed JSON', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const runtime = path.join(tmp, 'council.json');
  fs.writeFileSync(runtime, '{ not valid json');
  const defaultsPath = path.join(__dirname, '../skills/llm-council/defaults/council.json');
  const result = loadConfig({ runtimePath: runtime, defaultsPath });
  assert.equal(result.source, 'defaults');
  assert.match(result.warning, /malformed/i);
});

// ---- mode_packs -----------------------------------------------------------

const { resolveModePack } = require('../skills/llm-council/server/lib/config.cjs');

function withPack() {
  return {
    council: [
      { id: 'base-a', vendor: 'V', display: 'Base A', backend: 'task' },
      { id: 'base-b', vendor: 'V', display: 'Base B', backend: 'task' }
    ],
    chairman: 'base-a',
    chairman_backend: 'task',
    min_responses_to_proceed: 2,
    councillor_timeout_seconds: 120,
    mode_packs: {
      review: {
        council: [
          { id: 'crit-1', vendor: 'V', display: 'Critic 1', backend: 'task' },
          { id: 'crit-2', vendor: 'V', display: 'Critic 2', backend: 'task' },
          { id: 'crit-3', vendor: 'V', display: 'Critic 3', backend: 'task' }
        ],
        chairman: 'crit-1'
      },
      design: {
        chairman: 'base-b'  // partial override: keep council, swap chairman
      }
    }
  };
}

test('resolveModePack returns base when no mode is given', () => {
  const r = resolveModePack(withPack(), null);
  assert.equal(r.council.length, 2);
  assert.equal(r.chairman, 'base-a');
});

test('resolveModePack returns base for the general mode', () => {
  const r = resolveModePack(withPack(), 'general');
  assert.equal(r.council[0].id, 'base-a');
});

test('resolveModePack swaps council + chairman from a full pack', () => {
  const r = resolveModePack(withPack(), 'review');
  assert.equal(r.council.length, 3);
  assert.equal(r.council[0].id, 'crit-1');
  assert.equal(r.chairman, 'crit-1');
  assert.equal(r.resolved_mode, 'review');
});

test('resolveModePack applies partial overrides (chairman only)', () => {
  const r = resolveModePack(withPack(), 'design');
  assert.equal(r.council.length, 2);
  assert.equal(r.council[0].id, 'base-a');
  assert.equal(r.chairman, 'base-b');
  assert.equal(r.resolved_mode, 'design');
});

test('resolveModePack falls back to base when the pack is invalid', () => {
  const cfg = withPack();
  cfg.mode_packs.review.council = [{ id: 'lonely', vendor: 'V', display: 'L' }];  // <2 members
  const r = resolveModePack(cfg, 'review');
  assert.equal(r.council[0].id, 'base-a', 'base lineup should survive an invalid pack');
  assert.match(r.warning, /mode_packs\.review/);
});

test('resolveModePack returns base when the requested mode has no pack', () => {
  const r = resolveModePack(withPack(), 'plan');
  assert.equal(r.council[0].id, 'base-a');
});

test('loadConfig with mode= applies the pack', () => {
  const defaultsPath = path.join(__dirname, '../skills/llm-council/defaults/council.json');
  // Use the live defaults file which we ship with a review + design pack.
  const r = loadConfig({ runtimePath: '/nonexistent', defaultsPath, mode: 'review' });
  assert.equal(r.resolved_mode, 'review');
  // Sanity: review pack has 4 members (different from the default 5)
  assert.equal(r.council.length, 4);
});
