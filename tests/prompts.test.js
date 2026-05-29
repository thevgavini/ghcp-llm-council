const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROMPTS = path.join(__dirname, '../skills/llm-council/prompts');
const read = (...p) => fs.readFileSync(path.join(PROMPTS, ...p), 'utf8');
const MODES = ['general', 'review', 'design', 'plan', 'research'];

test('every mode ships a councillor prompt that forbids tool use and file reads', () => {
  for (const m of MODES) {
    const t = read(m, 'councillor.md');
    assert.match(t, /\b(no tools|do not use any tools)\b/i, `mode ${m}: should constrain tool use`);
    assert.match(t, /(read (?:external )?files|file reads|no file reads)/i, `mode ${m}: should forbid file reads`);
  }
});

test('every mode ships a chairman prompt with Q + STAGE1 + STAGE2 placeholders', () => {
  for (const m of MODES) {
    const t = read(m, 'chairman.md');
    assert.match(t, /\{\{QUESTION\}\}/, `mode ${m}: missing {{QUESTION}}`);
    assert.match(t, /\{\{STAGE1\}\}/, `mode ${m}: missing {{STAGE1}}`);
    assert.match(t, /\{\{STAGE2\}\}/, `mode ${m}: missing {{STAGE2}}`);
  }
});

test('ranker prompt is shared and requires FINAL RANKING format', () => {
  const t = read('ranker.md');
  assert.match(t, /FINAL RANKING:/);
  assert.match(t, /1\. Response [A-Z]/);
});

test('ranker prompt has {{QUESTION}} and {{RESPONSES}} placeholders', () => {
  const t = read('ranker.md');
  assert.match(t, /\{\{QUESTION\}\}/);
  assert.match(t, /\{\{RESPONSES\}\}/);
});
