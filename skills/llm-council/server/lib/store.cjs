const fs = require('node:fs');
const path = require('node:path');
const { newId, isoNow } = require('./ids.cjs');

function createStore({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const mem = new Map();

  function createConversation({ question }) {
    const id = newId('conv');
    const conv = { id, created_at: isoNow(), title: question.slice(0, 60), turns: [] };
    mem.set(id, conv);
    return { id };
  }

  function appendTurn(cid, { question }) {
    const conv = ensure(cid);
    const id = newId('turn');
    conv.turns.push({ id, question, stage: 0, councillors: [], rankings: [], label_map: {}, aggregate: [], synthesis: null, drills: [] });
    return { id };
  }

  function patchTurn(cid, tid, patch) {
    const conv = ensure(cid);
    const turn = conv.turns.find((t) => t.id === tid);
    if (!turn) throw new Error(`unknown turn: ${tid}`);
    Object.assign(turn, patch);
    if (patch.stage === 3) {
      fs.writeFileSync(path.join(dir, `${cid}.json`), JSON.stringify(conv, null, 2));
    }
  }

  function getConversation(cid) {
    if (mem.has(cid)) return mem.get(cid);
    const file = path.join(dir, `${cid}.json`);
    if (!fs.existsSync(file)) return null;
    const conv = JSON.parse(fs.readFileSync(file, 'utf8'));
    mem.set(cid, conv);
    return conv;
  }

  function listConversations() {
    const seen = new Map();
    for (const conv of mem.values()) {
      seen.set(conv.id, { id: conv.id, title: conv.title, created_at: conv.created_at });
    }
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!seen.has(c.id)) {
          seen.set(c.id, { id: c.id, title: c.title, created_at: c.created_at });
        }
      }
    }
    const items = Array.from(seen.values());
    items.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    return items;
  }

  function ensure(cid) {
    const conv = getConversation(cid);
    if (!conv) throw new Error(`unknown conversation: ${cid}`);
    return conv;
  }

  return { createConversation, appendTurn, patchTurn, getConversation, listConversations };
}

module.exports = { createStore };
