const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseRanking, aggregate } = require('../server/lib/ranking.cjs');

const fix = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/rankings', name), 'utf8');

test('parseRanking extracts numbered list under FINAL RANKING', () => {
  const result = parseRanking(fix('well-formed.txt'));
  assert.deepEqual(result, ['Response B', 'Response A', 'Response C']);
});

test('parseRanking falls back to any Response X matches when no numbered list', () => {
  const text = 'I think Response C is best, then Response A, finally Response B.';
  assert.deepEqual(parseRanking(text), ['Response C', 'Response A', 'Response B']);
});

test('parseRanking returns empty array for unparseable text', () => {
  assert.deepEqual(parseRanking(fix('unparseable.txt')), []);
});

test('parseRanking handles FINAL RANKING with extra whitespace and punctuation', () => {
  const text = 'preamble\n\nFINAL RANKING:\n  1.  Response A  \n  2.  Response B\n';
  assert.deepEqual(parseRanking(text), ['Response A', 'Response B']);
});

test('aggregate averages positions across ballots', () => {
  const labelToModel = { 'Response A': 'm1', 'Response B': 'm2', 'Response C': 'm3' };
  const ballots = [
    ['Response B', 'Response A', 'Response C'],
    ['Response A', 'Response B', 'Response C'],
    ['Response B', 'Response C', 'Response A']
  ];
  const result = aggregate(ballots, labelToModel);
  assert.deepEqual(result, [
    { model: 'm2', avg: 1.33, votes: 3 },
    { model: 'm1', avg: 2.00, votes: 3 },
    { model: 'm3', avg: 2.67, votes: 3 }
  ]);
});

test('aggregate handles missing votes (ranker failed)', () => {
  const labelToModel = { 'Response A': 'm1', 'Response B': 'm2' };
  const ballots = [
    ['Response A', 'Response B'],
    []
  ];
  const result = aggregate(ballots, labelToModel);
  assert.deepEqual(result, [
    { model: 'm1', avg: 1.00, votes: 1 },
    { model: 'm2', avg: 2.00, votes: 1 }
  ]);
});

test('aggregate ignores labels not in the label map', () => {
  const labelToModel = { 'Response A': 'm1' };
  const ballots = [['Response A', 'Response Z']];
  const result = aggregate(ballots, labelToModel);
  assert.deepEqual(result, [{ model: 'm1', avg: 1.00, votes: 1 }]);
});
