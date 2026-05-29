const { test } = require('node:test');
const assert = require('node:assert/strict');
const { newId, isoNow } = require('../server/lib/ids.cjs');

test('newId produces a prefixed, hex-suffixed id', () => {
  const id = newId('conv');
  assert.match(id, /^conv_[0-9a-f]{12}$/);
});

test('newId produces unique values across 100 calls', () => {
  const seen = new Set();
  for (let i = 0; i < 100; i++) seen.add(newId('t'));
  assert.equal(seen.size, 100);
});

test('isoNow returns a parseable ISO8601 string', () => {
  const s = isoNow();
  assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(s).toISOString(), s);
});
