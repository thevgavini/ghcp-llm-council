const fs = require('node:fs');
const path = require('node:path');
const { newId, isoNow } = require('./ids.cjs');

function createStore({ dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const mem = new Map();

  function createConversation({ question, mode }) {
    const id = newId('conv');
    const now = isoNow();
    const conv = {
      id,
      created_at: now,
      updated_at: now,
      title: question.slice(0, 60),
      mode: mode || 'general',
      turns: []
    };
    mem.set(id, conv);
    persist(conv);
    return { id };
  }

  function appendTurn(cid, { question }) {
    const conv = ensure(cid);
    const id = newId('turn');
    const now = isoNow();
    conv.turns.push({ id, question, created_at: now, stage: 0, councillors: [], rankings: [], label_map: {}, aggregate: [], synthesis: null, drills: [] });
    conv.updated_at = now;
    persist(conv);
    return { id };
  }

  const ALLOWED_PATCH_KEYS = new Set([
    'stage', 'councillors', 'rankings', 'label_map', 'aggregate', 'synthesis', 'drills'
  ]);

  function patchTurn(cid, tid, patch) {
    const conv = ensure(cid);
    const turn = conv.turns.find((t) => t.id === tid);
    if (!turn) throw new Error(`unknown turn: ${tid}`);
    for (const key of Object.keys(patch)) {
      if (!ALLOWED_PATCH_KEYS.has(key)) {
        throw new Error(`patch key not allowed: ${key}`);
      }
    }
    Object.assign(turn, patch);
    conv.updated_at = isoNow();
    // Persist on every mutation, not just at stage 3. Previously a server
    // restart (e.g. the 30-min idle shutdown) would lose any conversation
    // that hadn't reached chairman synthesis yet.
    persist(conv);
  }

  function persist(conv) {
    try {
      fs.writeFileSync(path.join(dir, `${conv.id}.json`), JSON.stringify(conv, null, 2));
    } catch (e) {
      // Best-effort: a bad disk shouldn't crash the API.
      console.error('store: persist failed', e.message);
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
    const pickTurns = (turns) =>
      (turns || []).map((t) => ({
        id: t.id,
        question: t.question,
        created_at: t.created_at,
        stage: t.stage
      }));
    for (const conv of mem.values()) {
      seen.set(conv.id, {
        id: conv.id,
        title: conv.title,
        mode: conv.mode || 'general',
        created_at: conv.created_at,
        updated_at: conv.updated_at || conv.created_at,
        turns: pickTurns(conv.turns)
      });
    }
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!seen.has(c.id)) {
          seen.set(c.id, {
            id: c.id,
            title: c.title,
            mode: c.mode || 'general',
            created_at: c.created_at,
            updated_at: c.updated_at || c.created_at,
            turns: pickTurns(c.turns)
          });
        }
      }
    }
    const items = Array.from(seen.values());
    items.sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
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
