const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '../prompts', name), 'utf8');

test('councillor prompt forbids tool use', () => {
  const t = read('councillor.md');
  assert.match(t, /do not use any tools/i);
  assert.match(t, /do not read files/i);
});

test('ranker prompt requires FINAL RANKING format', () => {
  const t = read('ranker.md');
  assert.match(t, /FINAL RANKING:/);
  assert.match(t, /1\. Response [A-Z]/);
});

test('ranker prompt has a {{QUESTION}} and {{RESPONSES}} placeholder', () => {
  const t = read('ranker.md');
  assert.match(t, /\{\{QUESTION\}\}/);
  assert.match(t, /\{\{RESPONSES\}\}/);
});

test('chairman prompt has Q + responses + rankings placeholders', () => {
  const t = read('chairman.md');
  assert.match(t, /\{\{QUESTION\}\}/);
  assert.match(t, /\{\{STAGE1\}\}/);
  assert.match(t, /\{\{STAGE2\}\}/);
});
