const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../skills/llm-council/server/lib/store.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
}

test('createConversation immediately persists to disk', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id } = store.createConversation({ question: 'q' });
  assert.match(id, /^conv_/);
  // Conversations are now persisted on every mutation so a server restart
  // (e.g. the idle timeout) never loses in-flight state.
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), true);
});

test('appendTurn returns a turn id', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id: cid } = store.createConversation({ question: 'q' });
  const { id: tid } = store.appendTurn(cid, { question: 'q' });
  assert.match(tid, /^turn_/);
});

test('patchTurn merges shallow fields', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id: cid } = store.createConversation({ question: 'q' });
  const { id: tid } = store.appendTurn(cid, { question: 'q' });
  store.patchTurn(cid, tid, { stage: 1 });
  store.patchTurn(cid, tid, { synthesis: { model: 'm', text: 'final' } });
  const conv = store.getConversation(cid);
  const turn = conv.turns.find((t) => t.id === tid);
  assert.equal(turn.stage, 1);
  assert.equal(turn.synthesis.text, 'final');
});

test('patchTurn with stage 3 persists conversation to disk', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id: cid } = store.createConversation({ question: 'q' });
  const { id: tid } = store.appendTurn(cid, { question: 'q' });
  store.patchTurn(cid, tid, { stage: 3, synthesis: { model: 'm', text: 'final' } });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${cid}.json`), 'utf8'));
  assert.equal(onDisk.id, cid);
  assert.equal(onDisk.turns[0].synthesis.text, 'final');
});

test('every patch persists the conversation (so partial turns survive restart)', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id: cid } = store.createConversation({ question: 'q' });
  const { id: tid } = store.appendTurn(cid, { question: 'q' });
  store.patchTurn(cid, tid, { stage: 1 });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `${cid}.json`), 'utf8'));
  assert.equal(onDisk.turns[0].stage, 1);
});

test('listConversations returns in reverse chronological order', async () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const a = store.createConversation({ question: 'a' });
  await new Promise((r) => setTimeout(r, 5));
  const b = store.createConversation({ question: 'b' });
  store.patchTurn(a.id, store.appendTurn(a.id, { question: 'a' }).id, { stage: 3, synthesis: { model: 'm', text: 'x' } });
  store.patchTurn(b.id, store.appendTurn(b.id, { question: 'b' }).id, { stage: 3, synthesis: { model: 'm', text: 'y' } });
  const list = store.listConversations();
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
});

test('getConversation reads from disk if not in memory', () => {
  const dir = tmpDir();
  const store1 = createStore({ dir });
  const { id: cid } = store1.createConversation({ question: 'q' });
  const { id: tid } = store1.appendTurn(cid, { question: 'q' });
  store1.patchTurn(cid, tid, { stage: 3, synthesis: { model: 'm', text: 'final' } });
  const store2 = createStore({ dir });
  const conv = store2.getConversation(cid);
  assert.equal(conv.turns[0].synthesis.text, 'final');
});
