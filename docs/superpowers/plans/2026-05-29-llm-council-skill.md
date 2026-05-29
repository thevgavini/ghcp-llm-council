# LLM Council Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained ghcp CLI skill that brings Karpathy's 3-stage LLM Council pattern to ghcp CLI, with a polished vanilla-JS web UI served by a built-in dependency-free Node server, using the agent's `task` tool for all model inference (no API keys).

**Architecture:** Two-process design. The Copilot CLI agent is the orchestrator (reads `SKILL.md`, dispatches `task` sub-agents per councillor, POSTs results to the local server). A long-lived Node server is the source of truth for session state, exposing REST + WebSocket to the browser and REST to the orchestrator. Browser is vanilla HTML/CSS/JS that subscribes to WS for live updates and POSTs user actions back.

**Tech Stack:** Node 20+ (built-in `http`, `fs`, `crypto`, WebSocket via hand-rolled RFC 6455), vanilla HTML/CSS/JS frontend (no build step, Inter via CDN with system-font fallback), Node's built-in `node --test` runner, GitHub Actions CI on Ubuntu/macOS/Windows × Node 20+22.

**Repo root for all paths in this plan:** `ghcp-llm-council/` (the skill repo). Paths shown are repo-relative.

---

## Task 1: Repo scaffold and tooling

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `README.md`
- Create: `tests/.gitkeep`

- [ ] **Step 1: Create `package.json`** (no dependencies, just metadata + test script)

```json
{
  "name": "ghcp-llm-council",
  "version": "0.1.0",
  "description": "A GitHub Copilot CLI skill that runs your question past a council of LLMs.",
  "license": "MIT",
  "type": "commonjs",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/",
    "test:watch": "node --test --watch tests/",
    "start": "node server/start.cjs"
  },
  "repository": { "type": "git", "url": "https://github.com/USER/ghcp-llm-council.git" }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
.llm-council/
*.log
.DS_Store
```

- [ ] **Step 3: Create `LICENSE`** (MIT, full text — replace `<YEAR>` and `<COPYRIGHT HOLDER>`)

```
MIT License

Copyright (c) 2026 ghcp-llm-council contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 4: Create `README.md` stub** (full content added in Task 18)

```markdown
# ghcp-llm-council

A GitHub Copilot CLI skill: a panel of LLMs deliberates on your question and synthesises a final answer, with a refined web UI to watch it unfold.

See `docs/superpowers/specs/2026-05-29-llm-council-skill-design.md` for the design.

Work in progress.
```

- [ ] **Step 5: Create empty `tests/.gitkeep`**

```bash
touch tests/.gitkeep
```

- [ ] **Step 6: Verify Node version and test runner work**

Run: `node --version`
Expected: `v20.x.x` or higher.

Run: `node --test tests/`
Expected: `# tests 0` (no tests yet, exit code 0).

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore LICENSE README.md tests/.gitkeep
git commit -m "chore: scaffold repo with MIT license and node test runner"
```

---

## Task 2: Pure-function module — ID generation and timestamps

**Files:**
- Create: `server/lib/ids.cjs`
- Create: `tests/ids.test.js`

Rationale: Both conversations and turns need unique IDs. Isolating this trivial concern first lets every later test use deterministic-shaped IDs without mocking.

- [ ] **Step 1: Write the failing test** at `tests/ids.test.js`

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ids.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** at `server/lib/ids.cjs`

```javascript
const crypto = require('node:crypto');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function isoNow() {
  return new Date().toISOString();
}

module.exports = { newId, isoNow };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ids.test.js`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/ids.cjs tests/ids.test.js
git commit -m "feat(server): id and timestamp helpers"
```

---

## Task 3: Pure-function module — ranking parser (Karpathy's regex + fallback)

**Files:**
- Create: `server/lib/ranking.cjs`
- Create: `tests/ranking.test.js`
- Create: `tests/fixtures/rankings/well-formed.txt`
- Create: `tests/fixtures/rankings/unparseable.txt`

Rationale: Stage-2 ranking text is messy. This is the single most likely place to have parser bugs. TDD it in isolation against fixture strings (including the malformed cases) before any networking exists.

- [ ] **Step 1: Create fixtures**

`tests/fixtures/rankings/well-formed.txt`:
```
Response A is thorough but verbose.
Response B nails the explanation in two sentences.
Response C is wrong about the date.

FINAL RANKING:
1. Response B
2. Response A
3. Response C
```

`tests/fixtures/rankings/unparseable.txt`:
```
I cannot rank these responses because the question is malformed.
None of them addressed the actual topic.
```

- [ ] **Step 2: Write the failing tests** at `tests/ranking.test.js`

```javascript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/ranking.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** at `server/lib/ranking.cjs`

```javascript
function parseRanking(text) {
  if (typeof text !== 'string') return [];
  const marker = 'FINAL RANKING:';
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    const section = text.slice(idx + marker.length);
    const numbered = section.match(/\d+\.\s*Response\s+[A-Z]/g);
    if (numbered && numbered.length) {
      return numbered.map((m) => m.match(/Response\s+[A-Z]/)[0].replace(/\s+/, ' '));
    }
  }
  const fallback = text.match(/Response\s+[A-Z]/g);
  if (!fallback) return [];
  return fallback.map((m) => m.replace(/\s+/, ' '));
}

function aggregate(ballots, labelToModel) {
  const positions = new Map();
  for (const ballot of ballots) {
    ballot.forEach((label, i) => {
      const model = labelToModel[label];
      if (!model) return;
      if (!positions.has(model)) positions.set(model, []);
      positions.get(model).push(i + 1);
    });
  }
  const rows = [];
  for (const [model, ps] of positions) {
    const avg = Math.round((ps.reduce((a, b) => a + b, 0) / ps.length) * 100) / 100;
    rows.push({ model, avg, votes: ps.length });
  }
  rows.sort((a, b) => a.avg - b.avg);
  return rows;
}

module.exports = { parseRanking, aggregate };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/ranking.test.js`
Expected: PASS — all 7 tests.

- [ ] **Step 6: Commit**

```bash
git add server/lib/ranking.cjs tests/ranking.test.js tests/fixtures/rankings/
git commit -m "feat(server): ranking parser and aggregator with Karpathy regex"
```

---
## Task 4: Config validation module

**Files:**
- Create: `defaults/council.json`
- Create: `server/lib/config.cjs`
- Create: `tests/config.test.js`

- [ ] **Step 1: Create defaults file** at `defaults/council.json`

```json
{
  "council": [
    {"id": "claude-sonnet-4.6", "vendor": "Anthropic", "display": "Claude Sonnet 4.6"},
    {"id": "claude-opus-4.7",   "vendor": "Anthropic", "display": "Claude Opus 4.7"},
    {"id": "gpt-5.2",           "vendor": "OpenAI",    "display": "GPT-5.2"},
    {"id": "gpt-5.3-codex",     "vendor": "OpenAI",    "display": "GPT-5.3 Codex"}
  ],
  "chairman": "claude-opus-4.7",
  "min_responses_to_proceed": 2,
  "councillor_timeout_seconds": 120
}
```

- [ ] **Step 2: Write the failing tests** at `tests/config.test.js`

```javascript
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** at `server/lib/config.cjs`

```javascript
const fs = require('node:fs');

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return { ok: false, error: 'config must be an object' };
  if (!Array.isArray(cfg.council)) return { ok: false, error: 'council must be an array' };
  if (cfg.council.length < 2) return { ok: false, error: 'council needs at least 2 members' };
  const ids = new Set();
  for (const c of cfg.council) {
    if (!c || typeof c.id !== 'string' || !c.id) return { ok: false, error: 'each councillor needs an id' };
    if (typeof c.vendor !== 'string') return { ok: false, error: 'each councillor needs a vendor' };
    if (typeof c.display !== 'string') return { ok: false, error: 'each councillor needs a display name' };
    if (ids.has(c.id)) return { ok: false, error: `duplicate councillor id: ${c.id}` };
    ids.add(c.id);
  }
  if (typeof cfg.chairman !== 'string' || !cfg.chairman) {
    return { ok: false, error: 'chairman must be a non-empty string' };
  }
  const min = cfg.min_responses_to_proceed;
  if (!Number.isInteger(min) || min < 1 || min > cfg.council.length) {
    return { ok: false, error: 'min_responses_to_proceed must be a positive integer ≤ council size' };
  }
  const to = cfg.councillor_timeout_seconds;
  if (!Number.isFinite(to) || to <= 0) {
    return { ok: false, error: 'councillor_timeout_seconds must be positive' };
  }
  return { ok: true };
}

function loadConfig({ runtimePath, defaultsPath }) {
  if (fs.existsSync(runtimePath)) {
    try {
      const raw = fs.readFileSync(runtimePath, 'utf8');
      const parsed = JSON.parse(raw);
      const v = validateConfig(parsed);
      if (v.ok) return { ...parsed, source: 'runtime' };
      return { ...JSON.parse(fs.readFileSync(defaultsPath, 'utf8')), source: 'defaults', warning: `runtime config invalid: ${v.error}` };
    } catch (e) {
      return { ...JSON.parse(fs.readFileSync(defaultsPath, 'utf8')), source: 'defaults', warning: `runtime config malformed: ${e.message}` };
    }
  }
  return { ...JSON.parse(fs.readFileSync(defaultsPath, 'utf8')), source: 'defaults' };
}

module.exports = { validateConfig, loadConfig };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/config.test.js`
Expected: PASS — all 9 tests.

- [ ] **Step 6: Commit**

```bash
git add defaults/council.json server/lib/config.cjs tests/config.test.js
git commit -m "feat(server): config validation and load-with-fallback"
```

---

## Task 5: Conversation persistence

**Files:**
- Create: `server/lib/store.cjs`
- Create: `tests/store.test.js`

- [ ] **Step 1: Write the failing tests** at `tests/store.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/lib/store.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
}

test('createConversation returns an id and persists nothing yet', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id } = store.createConversation({ question: 'q' });
  assert.match(id, /^conv_/);
  assert.equal(fs.existsSync(path.join(dir, `${id}.json`)), false);
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

test('partial turns (no stage:3) are not persisted', () => {
  const dir = tmpDir();
  const store = createStore({ dir });
  const { id: cid } = store.createConversation({ question: 'q' });
  const { id: tid } = store.appendTurn(cid, { question: 'q' });
  store.patchTurn(cid, tid, { stage: 1 });
  assert.equal(fs.existsSync(path.join(dir, `${cid}.json`)), false);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** at `server/lib/store.cjs`

```javascript
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
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const items = files.map((f) => {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { id: c.id, title: c.title, created_at: c.created_at };
    });
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/store.test.js`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/store.cjs tests/store.test.js
git commit -m "feat(server): in-memory + on-disk conversation store"
```

---

## Task 6: WebSocket framing (RFC 6455)

**Files:**
- Create: `server/lib/ws.cjs`
- Create: `tests/ws.test.js`

Rationale: Lifted from the brainstorming server's proven implementation. We re-implement (don't copy) and TDD it so we own it cleanly.

- [ ] **Step 1: Write the failing tests** at `tests/ws.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeAcceptKey, encodeFrame, decodeFrame, OPCODES } = require('../server/lib/ws.cjs');

test('computeAcceptKey matches RFC 6455 example', () => {
  // Sec-WebSocket-Key from RFC 6455 §1.3
  assert.equal(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame produces a valid small text frame', () => {
  const buf = encodeFrame(OPCODES.TEXT, Buffer.from('hi'));
  assert.equal(buf[0], 0x81);
  assert.equal(buf[1], 0x02);
  assert.equal(buf.slice(2).toString(), 'hi');
});

test('encodeFrame uses extended 16-bit length for payloads >=126', () => {
  const payload = Buffer.alloc(200, 'x');
  const buf = encodeFrame(OPCODES.TEXT, payload);
  assert.equal(buf[1], 126);
  assert.equal(buf.readUInt16BE(2), 200);
});

test('encodeFrame uses 64-bit length for payloads >=65536', () => {
  const payload = Buffer.alloc(70000, 'x');
  const buf = encodeFrame(OPCODES.TEXT, payload);
  assert.equal(buf[1], 127);
  assert.equal(Number(buf.readBigUInt64BE(2)), 70000);
});

test('decodeFrame round-trips a masked client text frame', () => {
  const payload = Buffer.from('hello');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | masked.length]),
    mask,
    masked
  ]);
  const result = decodeFrame(frame);
  assert.equal(result.opcode, OPCODES.TEXT);
  assert.equal(result.payload.toString(), 'hello');
});

test('decodeFrame returns null when buffer is incomplete', () => {
  assert.equal(decodeFrame(Buffer.from([0x81])), null);
});

test('decodeFrame throws on unmasked client frames', () => {
  assert.throws(() => decodeFrame(Buffer.from([0x81, 0x02, 0x68, 0x69])), /masked/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/ws.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** at `server/lib/ws.cjs`

```javascript
const crypto = require('node:crypto');

const OPCODES = { TEXT: 0x01, CLOSE: 0x08, PING: 0x09, PONG: 0x0A };
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function computeAcceptKey(clientKey) {
  return crypto.createHash('sha1').update(clientKey + WS_MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const fin = 0x80;
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = fin | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = fin | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = fin | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const second = buffer[1];
  const opcode = buffer[0] & 0x0F;
  const masked = (second & 0x80) !== 0;
  let payloadLen = second & 0x7F;
  let offset = 2;
  if (!masked) throw new Error('Client frames must be masked');
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  const dataOffset = offset + 4;
  const totalLen = dataOffset + payloadLen;
  if (buffer.length < totalLen) return null;
  const mask = buffer.slice(maskOffset, dataOffset);
  const data = Buffer.alloc(payloadLen);
  for (let i = 0; i < payloadLen; i++) data[i] = buffer[dataOffset + i] ^ mask[i % 4];
  return { opcode, payload: data, bytesConsumed: totalLen };
}

module.exports = { OPCODES, computeAcceptKey, encodeFrame, decodeFrame };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/ws.test.js`
Expected: PASS — all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/ws.cjs tests/ws.test.js
git commit -m "feat(server): RFC 6455 WebSocket framing"
```

---
## Task 7: HTTP server skeleton + static file serving

**Files:**
- Create: `server/lib/http.cjs`
- Create: `server/public/index.html` (stub)
- Create: `tests/http-static.test.js`

- [ ] **Step 1: Create UI stub** at `server/public/index.html`

```html
<!doctype html><html><head><meta charset="utf-8"><title>LLM Council</title></head>
<body><h1>LLM Council UI placeholder</h1></body></html>
```

- [ ] **Step 2: Write the failing tests** at `tests/http-static.test.js`

```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../server/lib/http.cjs');

let server, url, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'http-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../defaults/council.json')
  });
  await server.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${server.port}`;
});
after(async () => { await server.close(); });

test('GET / serves index.html', async () => {
  const res = await fetch(url + '/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /LLM Council UI placeholder/);
});

test('GET unknown path returns 404', async () => {
  const res = await fetch(url + '/does-not-exist');
  assert.equal(res.status, 404);
});

test('GET /api/health returns ok', async () => {
  const res = await fetch(url + '/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('listen on port 0 picks a random port', () => {
  assert.ok(server.port > 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/http-static.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** at `server/lib/http.cjs` (REST routes added in Task 8 — this step only does static + /api/health)

```javascript
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath }) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });
  const ctx = { publicDir, stateDir, conversationsDir, defaultsPath };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/health') return json(res, 200, { ok: true });
      if (req.url.startsWith('/api/')) return notFound(res); // routes added in Task 8
      const file = req.url === '/' ? '/index.html' : req.url;
      const resolved = path.normalize(path.join(publicDir, file));
      if (!resolved.startsWith(publicDir)) return notFound(res);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(resolved).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  function listen(port, host) {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        ctx.port = server.address().port;
        ctx.host = host;
        resolve();
      });
    });
  }
  function close() { return new Promise((r) => server.close(r)); }

  return new Proxy({ listen, close, server, ctx }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'port') return ctx.port;
      if (k === 'host') return ctx.host;
    }
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function notFound(res) { res.writeHead(404); res.end('not found'); }

module.exports = { createHttpServer, json, notFound };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/http-static.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add server/lib/http.cjs server/public/index.html tests/http-static.test.js
git commit -m "feat(server): http server with static file serving and health endpoint"
```

---

## Task 8: REST API endpoints

**Files:**
- Modify: `server/lib/http.cjs`
- Create: `tests/http-api.test.js`

- [ ] **Step 1: Write the failing tests** at `tests/http-api.test.js`

```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../server/lib/http.cjs');

let server, url, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../defaults/council.json')
  });
  await server.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${server.port}`;
});
after(async () => { await server.close(); });

async function api(method, p, body) {
  const res = await fetch(url + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('GET /api/config returns defaults when no runtime config exists', async () => {
  const { status, body } = await api('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(body.source, 'defaults');
  assert.ok(Array.isArray(body.council));
});

test('PUT /api/config validates and persists', async () => {
  const valid = {
    council: [
      { id: 'a', vendor: 'V', display: 'A' },
      { id: 'b', vendor: 'V', display: 'B' }
    ],
    chairman: 'a',
    min_responses_to_proceed: 2,
    councillor_timeout_seconds: 60
  };
  const r = await api('PUT', '/api/config', valid);
  assert.equal(r.status, 200);
  const get = await api('GET', '/api/config');
  assert.equal(get.body.source, 'runtime');
  assert.equal(get.body.councillor_timeout_seconds, 60);
});

test('PUT /api/config rejects invalid', async () => {
  const r = await api('PUT', '/api/config', { council: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least 2/);
});

test('POST /api/conversations + POST /turns + PATCH /turns', async () => {
  const c = await api('POST', '/api/conversations', { question: 'why?' });
  assert.equal(c.status, 201);
  const cid = c.body.id;

  const t = await api('POST', `/api/conversations/${cid}/turns`, { question: 'why?' });
  assert.equal(t.status, 201);
  const tid = t.body.id;

  const p = await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, stage: 1 });
  assert.equal(p.status, 200);

  const got = await api('GET', `/api/conversations/${cid}`);
  assert.equal(got.body.turns[0].stage, 1);
});

test('GET /api/conversations returns list', async () => {
  const r = await api('GET', '/api/conversations');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

test('POST /api/events appends to events file', async () => {
  const r = await api('POST', '/api/events', { type: 'follow-up', question: 'and?' });
  assert.equal(r.status, 200);
  const eventsFile = path.join(tmp, 'state/events');
  const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.type, 'follow-up');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/http-api.test.js`
Expected: FAIL — endpoints not found.

- [ ] **Step 3: Implement the REST handlers** — replace the `req.url.startsWith('/api/')` short-circuit in `server/lib/http.cjs` and add a router. Final `http.cjs`:

```javascript
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store.cjs');
const { loadConfig, validateConfig } = require('./config.cjs');

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath }) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });
  const store = createStore({ dir: conversationsDir });
  const runtimeConfigPath = path.join(stateDir, 'council.json');
  const eventsPath = path.join(stateDir, 'events');
  const listeners = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/health') return json(res, 200, { ok: true });
      if (req.url.startsWith('/api/')) return route(req, res);
      await staticServe(req, res);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  async function route(req, res) {
    const u = req.url; const m = req.method;
    if (m === 'GET' && u === '/api/config') {
      return json(res, 200, loadConfig({ runtimePath: runtimeConfigPath, defaultsPath }));
    }
    if (m === 'PUT' && u === '/api/config') {
      const body = await readJson(req);
      const v = validateConfig(body);
      if (!v.ok) return json(res, 400, { error: v.error });
      fs.writeFileSync(runtimeConfigPath, JSON.stringify(body, null, 2));
      emit({ type: 'config-changed' });
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && u === '/api/conversations') {
      const body = await readJson(req);
      return json(res, 201, store.createConversation({ question: body.question || '' }));
    }
    let mt = u.match(/^\/api\/conversations\/([^/]+)\/turns$/);
    if (mt && m === 'POST') {
      const cid = mt[1]; const body = await readJson(req);
      const t = store.appendTurn(cid, { question: body.question || '' });
      emit({ type: 'turn-update', conversation_id: cid, turn_id: t.id });
      return json(res, 201, t);
    }
    mt = u.match(/^\/api\/conversations\/([^/]+)$/);
    if (mt && m === 'GET') {
      const conv = store.getConversation(mt[1]);
      if (!conv) return json(res, 404, { error: 'not found' });
      return json(res, 200, conv);
    }
    if (m === 'GET' && u === '/api/conversations') {
      return json(res, 200, store.listConversations());
    }
    mt = u.match(/^\/api\/turns\/([^/]+)$/);
    if (mt && m === 'PATCH') {
      const tid = mt[1]; const body = await readJson(req);
      const cid = body.conversation_id;
      if (!cid) return json(res, 400, { error: 'conversation_id required' });
      const { conversation_id, ...patch } = body;
      store.patchTurn(cid, tid, patch);
      emit({ type: 'turn-update', conversation_id: cid, turn_id: tid, patch });
      return json(res, 200, { ok: true });
    }
    if (m === 'POST' && u === '/api/events') {
      const body = await readJson(req);
      const line = JSON.stringify({ ...body, timestamp: Date.now() }) + '\n';
      fs.appendFileSync(eventsPath, line);
      emit({ type: 'pending-input', payload: body });
      return json(res, 200, { ok: true });
    }
    return notFound(res);
  }

  async function staticServe(req, res) {
    const file = req.url === '/' ? '/index.html' : req.url;
    const resolved = path.normalize(path.join(publicDir, file));
    if (!resolved.startsWith(publicDir)) return notFound(res);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved).pipe(res);
  }

  function emit(evt) { for (const l of listeners) l(evt); }
  function onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const ctx = { publicDir, stateDir, conversationsDir, defaultsPath };
  function listen(port, host) {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        ctx.port = server.address().port;
        ctx.host = host;
        resolve();
      });
    });
  }
  function close() { return new Promise((r) => server.close(r)); }

  return new Proxy({ listen, close, server, onEvent, ctx }, {
    get(t, k) { if (k in t) return t[k]; if (k === 'port') return ctx.port; if (k === 'host') return ctx.host; }
  });
}

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function notFound(res) { res.writeHead(404); res.end('not found'); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = { createHttpServer };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/http-api.test.js tests/http-static.test.js`
Expected: PASS — all tests across both files.

- [ ] **Step 5: Commit**

```bash
git add server/lib/http.cjs tests/http-api.test.js
git commit -m "feat(server): REST endpoints for config, conversations, turns, events"
```

---

## Task 9: Wire WebSocket upgrade onto the HTTP server

**Files:**
- Modify: `server/lib/http.cjs`
- Create: `tests/ws-integration.test.js`

- [ ] **Step 1: Write the failing test** at `tests/ws-integration.test.js`

```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../server/lib/http.cjs');
const { decodeFrame, encodeFrame, OPCODES } = require('../server/lib/ws.cjs');

let server, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../defaults/council.json')
  });
  await server.listen(0, '127.0.0.1');
});
after(async () => { await server.close(); });

function wsHandshake(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const sep = buf.indexOf('\r\n\r\n');
        if (sep !== -1 && buf.slice(0, sep).includes('101')) {
          const remainder = buf.slice(sep + 4);
          resolve({ socket, remainder });
        }
      });
      socket.on('error', reject);
    });
  });
}

test('WS handshake succeeds and PATCH broadcasts turn-update', async () => {
  const { socket } = await wsHandshake(server.port);
  const received = [];
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      // server frames are unmasked, decode manually
      if (buf.length < 2) break;
      const len = buf[1] & 0x7F;
      let payloadStart = 2;
      let payloadLen = len;
      if (len === 126) { payloadLen = buf.readUInt16BE(2); payloadStart = 4; }
      else if (len === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); payloadStart = 10; }
      if (buf.length < payloadStart + payloadLen) break;
      received.push(buf.slice(payloadStart, payloadStart + payloadLen).toString());
      buf = buf.slice(payloadStart + payloadLen);
    }
  });

  const c = await (await fetch(`http://127.0.0.1:${server.port}/api/conversations`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question:'q' })})).json();
  const t = await (await fetch(`http://127.0.0.1:${server.port}/api/conversations/${c.id}/turns`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question:'q' })})).json();
  await fetch(`http://127.0.0.1:${server.port}/api/turns/${t.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ conversation_id: c.id, stage: 1 })});

  await new Promise((r) => setTimeout(r, 100));
  socket.end();
  const messages = received.map((m) => JSON.parse(m));
  const turnUpdates = messages.filter((m) => m.type === 'turn-update');
  assert.ok(turnUpdates.length >= 2, `expected ≥2 turn-update messages, got ${JSON.stringify(messages)}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ws-integration.test.js`
Expected: FAIL — handshake doesn't return 101.

- [ ] **Step 3: Add WebSocket upgrade handling to `server/lib/http.cjs`.** Inside `createHttpServer`, after `const server = http.createServer(...)`, add:

```javascript
const { computeAcceptKey, encodeFrame, OPCODES } = require('./ws.cjs');
const wsClients = new Set();
server.on('upgrade', (req, socket) => {
  if (req.url !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = computeAcceptKey(key);
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  wsClients.add(socket);
  socket.on('close', () => wsClients.delete(socket));
  socket.on('error', () => wsClients.delete(socket));
});
function broadcast(obj) {
  const payload = Buffer.from(JSON.stringify(obj));
  const frame = encodeFrame(OPCODES.TEXT, payload);
  for (const s of wsClients) { try { s.write(frame); } catch {} }
}
listeners.add((evt) => broadcast(evt));
```

Add `require` for `./ws.cjs` at the top of the file alongside the other requires.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ws-integration.test.js`
Expected: PASS — turn-update messages received.

- [ ] **Step 5: Run the full test suite**

Run: `node --test tests/`
Expected: PASS — all tests from Tasks 2–9.

- [ ] **Step 6: Commit**

```bash
git add server/lib/http.cjs tests/ws-integration.test.js
git commit -m "feat(server): WebSocket upgrade and broadcast on state changes"
```

---
## Task 10: Server entrypoint with idle timeout + owner-PID monitoring

**Files:**
- Create: `server/server.cjs`
- Create: `tests/server-lifecycle.test.js`

- [ ] **Step 1: Write the failing test** at `tests/server-lifecycle.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    stream.on('error', reject);
  });
}

test('server.cjs prints server-started JSON and writes server-info', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  const child = spawn(process.execPath, [path.join(__dirname, '../server/server.cjs')], {
    env: { ...process.env, LLM_COUNCIL_DIR: tmp, LLM_COUNCIL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const started = await readJsonLine(child.stdout);
    assert.equal(started.type, 'server-started');
    assert.ok(started.url.startsWith('http://127.0.0.1:'));
    assert.ok(fs.existsSync(path.join(tmp, 'state/server-info')));
    const info = JSON.parse(fs.readFileSync(path.join(tmp, 'state/server-info'), 'utf8'));
    assert.equal(info.port, started.port);
  } finally {
    child.kill();
  }
});

test('server.cjs exits when owner PID dies', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srv-'));
  // Spawn a short-lived "owner" process whose PID we hand to the server.
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
  const server = spawn(process.execPath, [path.join(__dirname, '../server/server.cjs')], {
    env: {
      ...process.env,
      LLM_COUNCIL_DIR: tmp,
      LLM_COUNCIL_HOST: '127.0.0.1',
      LLM_COUNCIL_OWNER_PID: String(owner.pid),
      LLM_COUNCIL_LIFECYCLE_INTERVAL_MS: '200'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await readJsonLine(server.stdout);
    owner.kill();
    const code = await new Promise((r) => server.on('exit', r));
    assert.equal(code, 0);
  } finally {
    try { server.kill(); } catch {}
    try { owner.kill(); } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/server-lifecycle.test.js`
Expected: FAIL — `server/server.cjs` does not exist.

- [ ] **Step 3: Implement** at `server/server.cjs`

```javascript
const fs = require('node:fs');
const path = require('node:path');
const { createHttpServer } = require('./lib/http.cjs');

const DIR = process.env.LLM_COUNCIL_DIR || path.join(process.cwd(), '.llm-council');
const HOST = process.env.LLM_COUNCIL_HOST || '127.0.0.1';
const URL_HOST = process.env.LLM_COUNCIL_URL_HOST || (HOST === '127.0.0.1' ? 'localhost' : HOST);
const OWNER_PID = process.env.LLM_COUNCIL_OWNER_PID ? Number(process.env.LLM_COUNCIL_OWNER_PID) : null;
const IDLE_MS = Number(process.env.LLM_COUNCIL_IDLE_MS || 30 * 60 * 1000);
const LIFECYCLE_MS = Number(process.env.LLM_COUNCIL_LIFECYCLE_INTERVAL_MS || 60 * 1000);

const stateDir = path.join(DIR, 'state');
const conversationsDir = path.join(DIR, 'conversations');
const publicDir = path.join(__dirname, 'public');
const defaultsPath = path.join(__dirname, '..', 'defaults', 'council.json');

fs.mkdirSync(stateDir, { recursive: true });

const server = createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath });

let lastActivity = Date.now();
server.onEvent && server.onEvent(() => { lastActivity = Date.now(); });

async function start() {
  await server.listen(0, HOST);
  const info = {
    type: 'server-started',
    port: server.port,
    host: HOST,
    url_host: URL_HOST,
    url: `http://${URL_HOST}:${server.port}`,
    session_dir: DIR,
    state_dir: stateDir
  };
  fs.writeFileSync(path.join(stateDir, 'server-info'), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(stateDir, 'server.pid'), String(process.pid));
  console.log(JSON.stringify(info));
}

function shutdown(reason) {
  const info = path.join(stateDir, 'server-info');
  if (fs.existsSync(info)) fs.unlinkSync(info);
  fs.writeFileSync(path.join(stateDir, 'server-stopped'), JSON.stringify({ reason, timestamp: Date.now() }) + '\n');
  console.log(JSON.stringify({ type: 'server-stopped', reason }));
  server.close().then(() => process.exit(0));
}

function ownerAlive() {
  if (!OWNER_PID) return true;
  try { process.kill(OWNER_PID, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

setInterval(() => {
  if (!ownerAlive()) shutdown('owner process exited');
  else if (Date.now() - lastActivity > IDLE_MS) shutdown('idle timeout');
}, LIFECYCLE_MS).unref();

process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));

start().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/server-lifecycle.test.js`
Expected: PASS — both lifecycle tests.

- [ ] **Step 5: Commit**

```bash
git add server/server.cjs tests/server-lifecycle.test.js
git commit -m "feat(server): entrypoint with idle + owner-pid monitoring"
```

---

## Task 11: Cross-platform launcher (`start.cjs`) and stopper (`stop.cjs`)

**Files:**
- Create: `server/start.cjs`
- Create: `server/stop.cjs`
- Create: `tests/start-stop.test.js`

Rationale: Pure-Node launcher so the skill works on Windows without bash. Forks `server.cjs` detached, waits for `server-info`, prints JSON, exits.

- [ ] **Step 1: Write the failing test** at `tests/start-stop.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('start.cjs starts server in background and prints server-started JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-'));
  const result = spawnSync(process.execPath, [path.join(__dirname, '../server/start.cjs'), '--dir', tmp], { encoding: 'utf8' });
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
  spawnSync(process.execPath, [path.join(__dirname, '../server/start.cjs'), '--dir', tmp]);
  const stop = spawnSync(process.execPath, [path.join(__dirname, '../server/stop.cjs'), '--dir', tmp], { encoding: 'utf8' });
  assert.equal(stop.status, 0, stop.stderr);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(tmp, 'state/server-info')), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/start-stop.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement** `server/start.cjs`

```javascript
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--owner-pid') out.ownerPid = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || path.join(process.cwd(), '.llm-council');
const host = args.host || '127.0.0.1';
const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const infoPath = path.join(stateDir, 'server-info');
const pidPath = path.join(stateDir, 'server.pid');
if (fs.existsSync(pidPath)) {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    process.kill(pid, 0);
    if (fs.existsSync(infoPath)) {
      console.log(fs.readFileSync(infoPath, 'utf8').trim());
      process.exit(0);
    }
  } catch {}
}

const env = { ...process.env, LLM_COUNCIL_DIR: dir, LLM_COUNCIL_HOST: host };
if (args.ownerPid) env.LLM_COUNCIL_OWNER_PID = String(args.ownerPid);

const logFile = fs.openSync(path.join(stateDir, 'server.log'), 'a');
const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
  env, detached: true, stdio: ['ignore', logFile, logFile]
});
child.unref();

const deadline = Date.now() + 5000;
(function waitForInfo() {
  if (fs.existsSync(infoPath)) {
    console.log(fs.readFileSync(infoPath, 'utf8').trim());
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error('Server did not start within 5 seconds');
    process.exit(1);
  }
  setTimeout(waitForInfo, 100);
})();
```

- [ ] **Step 4: Implement** `server/stop.cjs`

```javascript
const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || path.join(process.cwd(), '.llm-council');
const pidPath = path.join(dir, 'state', 'server.pid');

if (!fs.existsSync(pidPath)) {
  console.log(JSON.stringify({ type: 'noop', reason: 'no pid file' }));
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidPath, 'utf8'));
try {
  process.kill(pid);
  console.log(JSON.stringify({ type: 'stopped', pid }));
} catch (e) {
  console.log(JSON.stringify({ type: 'noop', reason: e.code || e.message }));
}
process.exit(0);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/start-stop.test.js`
Expected: PASS — both tests.

- [ ] **Step 6: Commit**

```bash
git add server/start.cjs server/stop.cjs tests/start-stop.test.js
git commit -m "feat(server): cross-platform start.cjs and stop.cjs launchers"
```

---

## Task 12: Prompt templates (lifted from Karpathy with no-tools constraint)

**Files:**
- Create: `prompts/councillor.md`
- Create: `prompts/ranker.md`
- Create: `prompts/chairman.md`
- Create: `tests/prompts.test.js`

- [ ] **Step 1: Write the failing tests** at `tests/prompts.test.js`

```javascript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/prompts.test.js`
Expected: FAIL — files not found.

- [ ] **Step 3: Create** `prompts/councillor.md`

```markdown
You are a councillor on a panel of LLMs answering a user's question.

Constraints:
- Answer from your own knowledge only.
- Do not use any tools.
- Do not read files. Do not search. Do not browse the web.
- Be concise but substantive. Aim for 4–8 short paragraphs unless the question is trivial.
- Do not refer to other councillors — your peers are answering the same question independently.
- Do not preface with "Great question" or similar filler.

The user's question follows.
```

- [ ] **Step 4: Create** `prompts/ranker.md`

```markdown
You are evaluating different responses to the following question:

Question: {{QUESTION}}

Here are the responses from different models (anonymised):

{{RESPONSES}}

Your task:
1. First, evaluate each response individually. For each response, explain what it does well and what it does poorly.
2. Then, at the very end of your response, provide a final ranking.

IMPORTANT: Your final ranking MUST be formatted EXACTLY as follows:
- Start with the line "FINAL RANKING:" (all caps, with colon)
- Then list the responses from best to worst as a numbered list
- Each line should be: number, period, space, then ONLY the response label (e.g., "1. Response A")
- Do not add any other text or explanations in the ranking section

Example of the correct format for the ranking block:

FINAL RANKING:
1. Response C
2. Response A
3. Response B

Now provide your evaluation and ranking.

Constraints: answer from your own knowledge only. Do not use any tools. Do not read files.
```

- [ ] **Step 5: Create** `prompts/chairman.md`

```markdown
You are the Chairman of an LLM Council. Multiple AI models have provided responses to a user's question, and then ranked each other's responses.

Original question:
{{QUESTION}}

Stage 1 — individual responses:
{{STAGE1}}

Stage 2 — peer rankings (raw text):
{{STAGE2}}

Your task as Chairman is to synthesise all of this information into a single, comprehensive, accurate answer to the user's original question. Consider:
- The individual responses and their insights.
- The peer rankings and what they reveal about response quality.
- Any patterns of agreement or disagreement.

Provide a clear, well-reasoned final answer that represents the council's collective wisdom. Do not enumerate the councillors or restate the process — give the answer directly.

Constraints: answer from your own knowledge plus the provided context. Do not use any tools. Do not read files.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test tests/prompts.test.js`
Expected: PASS — all 4 tests.

- [ ] **Step 7: Commit**

```bash
git add prompts/ tests/prompts.test.js
git commit -m "feat(prompts): councillor, ranker, chairman templates"
```

---
## Task 13: `SKILL.md` — the orchestrator instructions

**Files:**
- Create: `SKILL.md`

Rationale: This is the contract between the ghcp CLI agent and our server. It encodes the 3-stage loop in a form the agent reads at invocation time. No automated test — this is documentation the agent executes.

- [ ] **Step 1: Create** `SKILL.md`

````markdown
# llm-council

A panel of LLMs deliberates on the user's question across three stages — independent first opinions, anonymised peer review, and a chairman's synthesis — visualised live in a local web UI.

## When to use

Use this skill when the user:

- Asks the council, asks a panel of models, requests multiple opinions, wants several models to weigh in.
- Says "ask the council X", "get a council take on Y", "council: Z", "multi-model opinion on …".
- Explicitly invokes the council for a question they want carefully deliberated.

Do not use this skill for:

- Routine questions where one opinion is enough.
- Tool-using tasks (code editing, file reading, running commands) — councillors are constrained to answer from their own knowledge only.

## Repo layout (paths relative to this file)

```
SKILL.md                        ← this file
prompts/{councillor,ranker,chairman}.md
defaults/council.json
server/start.cjs                ← launch the UI server
server/stop.cjs
server/server.cjs
server/public/                  ← browser app
```

## Per-session state lives under `<cwd>/.llm-council/`

```
.llm-council/
  state/
    server-info     (URL, port, pid)  ← presence = server is up
    server.pid
    server.log
    events          (browser → orchestrator, JSONL)
    council.json    (runtime config; overrides defaults/council.json when present)
  conversations/
    <conv-id>.json
```

## Lifecycle — every invocation

1. Check `<cwd>/.llm-council/state/server-info`.
   - If it exists and the PID inside `server.pid` is alive, reuse the server. Read `url` from `server-info`.
   - Otherwise, launch:
     ```
     node <skill_dir>/server/start.cjs --dir <cwd>/.llm-council --owner-pid <YOUR_PID_IF_KNOWN>
     ```
     The launcher prints the `server-started` JSON line on stdout and exits. Parse the JSON to get `url`.
2. Tell the user: "Council convened at <url>".

## The 3-stage loop (per user question)

### Stage 0 — open a conversation and turn

```
POST <url>/api/conversations           body: { "question": <user question> }   → { "id": <cid> }
POST <url>/api/conversations/<cid>/turns body: { "question": <user question> } → { "id": <tid> }
```

### Stage 1 — first opinions (parallel)

Read the current council from `GET /api/config`. For each councillor:

1. Compose the prompt: contents of `prompts/councillor.md` + a blank line + the user's question.
2. Dispatch a `task` sub-agent in **background** mode with the councillor's `id` as the `model` override. Constrain to its scope: the only goal is to answer the question. The councillor prompt instructs the sub-agent not to use tools — honour that.
3. When each agent completes, PATCH the turn:
   ```
   PATCH <url>/api/turns/<tid>  body: {
     "conversation_id": "<cid>",
     "councillors": [ {<existing councillors>}, { "id": <model>, "status": "ok", "response": <text>, "latency_ms": <ms> } ]
   }
   ```
   If the agent times out (> `councillor_timeout_seconds` from config), errors, or returns empty/garbage, mark `status` as `"timeout"`, `"error"`, or `"empty"` accordingly and include an error message field.

When ≥ `min_responses_to_proceed` councillors have a non-error status (or all have terminated), advance:
```
PATCH <url>/api/turns/<tid>  body: { "conversation_id": "<cid>", "stage": 2 }
```

If fewer than `min_responses_to_proceed` succeeded, instead PATCH `stage: -1` with an error and stop. The browser will show a Retry All button; on next turn read `state/events` for a `retry-all` action.

### Stage 2 — anonymised peer review (parallel)

Build a `label_map` mapping `"Response A"`, `"Response B"`, … to the surviving councillor IDs (deterministic order: order they appeared in the council config). Keep `label_map` server-side too:
```
PATCH <url>/api/turns/<tid>  body: { "conversation_id": "<cid>", "label_map": { ... } }
```

For each surviving councillor (acting now as a ranker):

1. Compose the prompt: contents of `prompts/ranker.md` with `{{QUESTION}}` replaced by the user's question and `{{RESPONSES}}` replaced by a labelled concatenation:
   ```
   Response A:
   <text from councillor A>

   Response B:
   <text from councillor B>
   ...
   ```
2. Dispatch a `task` sub-agent in background mode with that councillor's model.
3. When each ranking returns, parse it using the same logic as `server/lib/ranking.cjs::parseRanking`. Then PATCH:
   ```
   PATCH <url>/api/turns/<tid>  body: {
     "conversation_id": "<cid>",
     "rankings": [ {<existing>}, { "ranker": <id>, "raw": <full text>, "parsed": [<labels>] } ]
   }
   ```

When all rankings are in (or all timed out), compute aggregate using `aggregate(ballots, label_map)` from the same module, then PATCH:
```
PATCH <url>/api/turns/<tid>  body: { "conversation_id": "<cid>", "aggregate": [...] }
```

### Stage 3 — chairman synthesis (single agent)

1. Compose the prompt: contents of `prompts/chairman.md` with placeholders replaced by:
   - `{{QUESTION}}` = the user's question
   - `{{STAGE1}}` = each councillor's response, prefixed `Model: <id>\nResponse: <text>\n\n`
   - `{{STAGE2}}` = each ranker's raw text, prefixed `Model: <id>\nRanking: <raw>\n\n`
2. Dispatch one `task` sub-agent with the chairman model from config.
3. On completion, PATCH:
   ```
   PATCH <url>/api/turns/<tid>  body: {
     "conversation_id": "<cid>",
     "stage": 3,
     "synthesis": { "model": <chairman id>, "text": <text> }
   }
   ```
   The server persists the completed conversation to disk on receipt of `stage: 3`.

4. Tell the user in the terminal: "Synthesis ready at <url>. Final answer also pasted below for convenience:" then paste the synthesis as markdown.

## Follow-ups and drill-down

At the start of every new turn (and once after Stage 3 completes), read `<cwd>/.llm-council/state/events` (line-by-line JSON). Process and clear (truncate) the file. Event types you must handle:

- `{ "type": "follow-up", "conversation_id": "<cid>", "question": "<q>" }`
  → Start a new turn on the same conversation (Stage 0 with that cid, then run the 3-stage loop).
- `{ "type": "drill", "conversation_id": "<cid>", "councillor_id": "<id>", "question": "<q>" }`
  → Dispatch a single `task` agent with that model + councillor prompt + the drill question. PATCH:
  `body: { "conversation_id": "<cid>", "drills": [ {<existing>}, { "councillor": <id>, "question": <q>, "response": <text> } ] }`
  (Do NOT advance stage; this attaches under the current turn.)
- `{ "type": "retry-councillor", "conversation_id": "<cid>", "turn_id": "<tid>", "councillor_id": "<id>" }`
  → Re-dispatch just that councillor. If the current turn has already advanced past Stage 2, treat as a "late response" and PATCH it with a marker indicating it was not included in peer review.
- `{ "type": "retry-all", "conversation_id": "<cid>", "turn_id": "<tid>" }`
  → Re-run Stages 1–3 on the same turn.
- `{ "type": "config-changed" }`
  → Re-fetch `GET /api/config` before the next turn.

## Failure handling

- All-councillors-fail in Stage 1: PATCH `stage: -1` with an error. Surface to user in terminal too.
- Ranker's text is unparseable: keep the ranker's raw text in `rankings` with `parsed: []`. The aggregate step ignores empty ballots.
- Chairman fails: PATCH `synthesis: { error: <msg> }` with `stage: 3` so the conversation is persisted. Tell user in terminal.
- Server unreachable mid-turn: try `node <skill_dir>/server/start.cjs --dir <cwd>/.llm-council` once. If it succeeds, re-emit all PATCHes for the current turn from your in-memory state. If it fails twice, fall back to pasting all results as markdown in the terminal.
- Config references a `task` model you don't support: skip that councillor, PATCH a status `"unsupported_model"` for it, continue.

## Quick reference — REST endpoints you call

| Method | Path | Body |
|---|---|---|
| GET    | /api/config | — |
| POST   | /api/conversations | `{ question }` |
| POST   | /api/conversations/:cid/turns | `{ question }` |
| PATCH  | /api/turns/:tid | `{ conversation_id, …patch }` |
| GET    | /api/conversations/:cid | — |
````

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "feat(skill): SKILL.md orchestrator instructions for the 3-stage loop"
```

---

## Task 14: Browser UI — HTML shell

**Files:**
- Modify (replace): `server/public/index.html`

Use the approved mockup (from the brainstorming session) as the visual baseline. This task wires the static shell. Live rendering and interactivity come in Task 15.

- [ ] **Step 1: Replace `server/public/index.html`** with the production shell

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLM Council</title>
  <link rel="preconnect" href="https://rsms.me/">
  <link rel="stylesheet" href="https://rsms.me/inter/inter.css">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div id="app">
    <aside id="sidebar">
      <header class="brand">
        <div class="brand-mark"></div>
        <div class="brand-name">Council<span>panel of LLMs</span></div>
      </header>
      <button id="new-conversation" class="btn">+ New conversation</button>
      <nav id="history" class="history"></nav>
      <footer class="sidebar-footer">
        <button id="open-settings" class="btn ghost">⚙ Settings</button>
      </footer>
    </aside>

    <main id="main">
      <section id="empty" class="empty">
        <h1>Ask the council.</h1>
        <p class="subtitle">Or type your question in the terminal — it'll appear here.</p>
      </section>

      <section id="conversation" hidden>
        <header class="conv-head">
          <div class="eyebrow">Current question</div>
          <h1 id="conv-question" class="question"></h1>
          <div id="conv-meta" class="session-meta"></div>
        </header>

        <div id="stage-rail" class="stage-rail"></div>
        <div id="stage-content" class="stage-content"></div>

        <form id="composer" class="composer">
          <input id="composer-input" placeholder="Ask the council a follow-up…" autocomplete="off">
          <span class="kbd">⏎</span>
        </form>
      </section>
    </main>

    <aside id="settings-drawer" class="drawer" hidden>
      <header class="drawer-head">
        <h2>Council settings</h2>
        <button id="close-settings" class="btn ghost">Close</button>
      </header>
      <form id="settings-form">
        <label class="field">
          <span>Chairman</span>
          <select id="settings-chairman"></select>
        </label>
        <label class="field">
          <span>Min responses to proceed</span>
          <input id="settings-min" type="number" min="1" value="2">
        </label>
        <label class="field">
          <span>Councillor timeout (seconds)</span>
          <input id="settings-timeout" type="number" min="10" value="120">
        </label>
        <fieldset class="field">
          <legend>Councillors</legend>
          <div id="settings-councillors"></div>
        </fieldset>
        <div class="drawer-actions">
          <button type="submit" class="btn primary">Save</button>
          <span id="settings-status" class="muted"></span>
        </div>
      </form>
    </aside>
  </div>

  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `server/public/app.css`** with the approved design tokens + components

```css
/* Inter typography, restrained violet accent, light/dark via prefers-color-scheme. */
:root {
  --bg:#faf9f7; --surface:#fff; --surface-elev:#fff;
  --hairline:rgba(15,15,17,.07); --hairline-strong:rgba(15,15,17,.12);
  --ink:#0e0e10; --ink-soft:#3a3a40; --ink-mute:#76767e; --ink-faint:#aeaeb6;
  --accent:#5b4cff; --accent-soft:rgba(91,76,255,.08); --accent-line:rgba(91,76,255,.18);
  --warm:#c97a3a; --good:#2f9e6b; --bad:#c0473a;
  --shadow-sm:0 1px 2px rgba(15,15,17,.04); --shadow-md:0 6px 24px rgba(15,15,17,.06);
  --r-md:10px; --r-lg:16px;
  --mono:ui-monospace,"SF Mono",Menlo,monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg:#0c0c0e; --surface:#131316; --surface-elev:#18181c;
    --hairline:rgba(255,255,255,.06); --hairline-strong:rgba(255,255,255,.12);
    --ink:#f3f3f5; --ink-soft:#c8c8cf; --ink-mute:#8a8a92; --ink-faint:#5a5a62;
    --accent:#8c7dff; --accent-soft:rgba(140,125,255,.10); --accent-line:rgba(140,125,255,.24);
  }
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;letter-spacing:-.011em;line-height:1.5}
@supports (font-variation-settings:normal){body{font-family:'Inter var',system-ui,sans-serif}}

#app{display:grid;grid-template-columns:260px 1fr;min-height:100vh}
#sidebar{border-right:1px solid var(--hairline);background:var(--surface);padding:24px 16px;display:flex;flex-direction:column;gap:16px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.brand-mark{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,var(--accent),#8c7dff);box-shadow:0 4px 12px var(--accent-soft)}
.brand-name{font-size:14px;font-weight:600;letter-spacing:-.02em}
.brand-name span{color:var(--ink-mute);font-weight:400;margin-left:6px;font-size:11px}
.btn{padding:8px 12px;border-radius:8px;border:1px solid var(--hairline-strong);background:var(--surface-elev);color:var(--ink);font-family:inherit;font-size:13px;cursor:pointer;text-align:left}
.btn.ghost{border-color:transparent;background:transparent;color:var(--ink-mute)}
.btn.primary{background:var(--accent);color:#fff;border-color:transparent;font-weight:500}
.history{flex:1;display:flex;flex-direction:column;gap:4px;overflow-y:auto;margin-top:8px}
.history .item{padding:8px 10px;border-radius:6px;cursor:pointer;font-size:13px;color:var(--ink-soft)}
.history .item:hover{background:var(--accent-soft)}
.history .item.active{background:var(--accent-soft);color:var(--accent)}
.history .item .date{display:block;font-size:11px;color:var(--ink-faint);margin-top:2px;font-variant-numeric:tabular-nums}
.sidebar-footer{border-top:1px solid var(--hairline);padding-top:12px}

#main{padding:56px 40px 120px;max-width:880px;width:100%;margin:0 auto}
.empty{text-align:center;padding:80px 0;color:var(--ink-mute)}
.empty h1{font-size:24px;font-weight:500;color:var(--ink);margin-bottom:8px}
.eyebrow{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:12px}
.question{font-size:28px;font-weight:500;letter-spacing:-.025em;line-height:1.25}
.session-meta{display:flex;gap:12px;margin-top:14px;font-size:12px;color:var(--ink-mute);font-variant-numeric:tabular-nums}

.stage-rail{display:flex;margin:32px 0;border-radius:var(--r-md);background:var(--surface);border:1px solid var(--hairline);box-shadow:var(--shadow-sm);overflow:hidden}
.stage{flex:1;padding:14px 18px;cursor:pointer;border-right:1px solid var(--hairline);position:relative}
.stage:last-child{border-right:none}
.stage.active{background:var(--accent-soft)}
.stage.active::after{content:'';position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--accent)}
.stage-meta{display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-mute);font-weight:500}
.stage-meta .num{font-family:var(--mono);font-size:10px;color:var(--ink-faint);background:var(--bg);padding:2px 6px;border-radius:4px;border:1px solid var(--hairline)}
.stage-title{font-size:14px;font-weight:500;margin-top:4px}
.stage-status{font-size:11px;color:var(--ink-mute);margin-top:2px;display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.pulse{width:6px;height:6px;border-radius:50%;background:var(--warm);animation:pulse 1.6s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(201,122,58,.5)}70%{box-shadow:0 0 0 6px rgba(201,122,58,0)}100%{box-shadow:0 0 0 0 rgba(201,122,58,0)}}
.check{width:12px;height:12px;border-radius:50%;background:var(--good);display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:8px;font-weight:700}
.fail{width:12px;height:12px;border-radius:50%;background:var(--bad);display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:8px;font-weight:700}

.stage-content{min-height:300px}
.councillors{display:flex;flex-direction:column;gap:1px;background:var(--hairline);border-radius:var(--r-lg);border:1px solid var(--hairline);overflow:hidden;box-shadow:var(--shadow-sm)}
.councillor{background:var(--surface);padding:22px 24px;cursor:pointer}
.councillor:hover{background:var(--surface-elev)}
.councillor-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.avatar{width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:12px;font-weight:600;color:#fff;flex-shrink:0}
.avatar[data-vendor="Anthropic"]{background:linear-gradient(135deg,#c96442,#b8533a)}
.avatar[data-vendor="OpenAI"]{background:linear-gradient(135deg,#2f9e6b,#258055)}
.avatar[data-vendor="Google"]{background:linear-gradient(135deg,#4285f4,#3367d6)}
.avatar[data-vendor="xAI"]{background:linear-gradient(135deg,#1d1d1f,#3a3a40)}
.name-block{flex:1;min-width:0}
.councillor-name{font-size:14px;font-weight:600;letter-spacing:-.015em}
.vendor-tag{font-family:var(--mono);font-size:10px;color:var(--ink-mute);margin-top:2px}
.latency{font-family:var(--mono);font-size:11px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.response{font-size:14px;line-height:1.65;color:var(--ink-soft);max-height:4.95em;overflow:hidden;mask-image:linear-gradient(to bottom,black 60%,transparent)}
.response.expanded{max-height:none;mask-image:none}
.expand-row{display:flex;align-items:center;gap:6px;margin-top:12px;color:var(--accent);font-size:12px;font-weight:500;cursor:pointer}

.skeleton-line{height:12px;border-radius:4px;background:linear-gradient(90deg,var(--hairline) 0%,var(--hairline-strong) 50%,var(--hairline) 100%);background-size:200% 100%;animation:shimmer 1.4s ease-in-out infinite;margin-bottom:8px}
.skeleton-line:nth-child(1){width:92%}
.skeleton-line:nth-child(2){width:78%}
.skeleton-line:nth-child(3){width:65%}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.thinking-label{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--warm);margin-bottom:12px;font-weight:500}

.aggregate{margin-top:24px;border:1px solid var(--hairline);border-radius:var(--r-md);overflow:hidden}
.aggregate table{width:100%;border-collapse:collapse;font-size:13px}
.aggregate th,.aggregate td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--hairline)}
.aggregate th{background:var(--bg);font-weight:500;color:var(--ink-mute);font-size:11px;letter-spacing:.04em;text-transform:uppercase}
.aggregate td.num{font-family:var(--mono);font-variant-numeric:tabular-nums}

.synthesis{background:var(--surface);border:1px solid var(--accent-line);border-radius:var(--r-lg);padding:28px;box-shadow:var(--shadow-md)}
.synthesis-label{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin-bottom:12px}
.synthesis-body{font-size:15px;line-height:1.7;color:var(--ink)}
.synthesis-body p{margin-bottom:1em}
.synthesis-body code{font-family:var(--mono);font-size:13px;background:var(--bg);padding:1px 5px;border-radius:3px}

.composer{margin-top:32px;background:var(--surface);border:1px solid var(--hairline);border-radius:var(--r-lg);padding:14px 18px;display:flex;align-items:center;gap:12px;box-shadow:var(--shadow-sm)}
.composer:focus-within{border-color:var(--accent-line);box-shadow:0 0 0 4px var(--accent-soft)}
.composer input{flex:1;border:none;background:transparent;font:inherit;font-size:14px;color:var(--ink);outline:none}
.composer .kbd{font-family:var(--mono);font-size:10px;color:var(--ink-mute);padding:3px 6px;border:1px solid var(--hairline-strong);border-radius:4px;background:var(--bg)}

.drawer{position:fixed;top:0;right:0;width:380px;height:100vh;background:var(--surface);border-left:1px solid var(--hairline);box-shadow:var(--shadow-md);padding:24px;overflow-y:auto;z-index:10}
.drawer-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.field{display:block;margin-bottom:16px}
.field>span,.field>legend{display:block;font-size:11px;font-weight:500;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-mute);margin-bottom:6px}
.field input,.field select{width:100%;padding:8px 10px;border:1px solid var(--hairline-strong);border-radius:6px;background:var(--bg);color:var(--ink);font:inherit;font-size:13px}
.drawer-actions{display:flex;align-items:center;gap:12px;margin-top:24px}
.muted{color:var(--ink-mute);font-size:12px}
.councillor-row{display:flex;gap:8px;align-items:center;margin-bottom:8px;padding:8px;border:1px solid var(--hairline);border-radius:6px}
.councillor-row input{flex:1}
.councillor-row button{padding:4px 8px;font-size:11px}
```

- [ ] **Step 2.5: Smoke-test in browser by starting the server manually**

```bash
node server/start.cjs --dir /tmp/llm-council-smoke
# open the printed URL — verify the shell renders with brand, sidebar, empty state
node server/stop.cjs --dir /tmp/llm-council-smoke
```

(On Windows substitute a temp dir like `$env:TEMP\llm-council-smoke`.)

- [ ] **Step 3: Commit**

```bash
git add server/public/index.html server/public/app.css
git commit -m "feat(ui): production HTML shell and design-token CSS"
```

---

## Task 15: Browser UI — live rendering with WebSocket + REST

**Files:**
- Create: `server/public/app.js`
- Create: `server/public/vendor/marked.min.js`  (vendored markdown renderer)

- [ ] **Step 1: Vendor a markdown library.** Download a small markdown parser to keep the build-free promise. Use `marked` UMD build pinned to a specific minor version.

```bash
mkdir -p server/public/vendor
curl -fSsL -o server/public/vendor/marked.min.js https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js
```

Verify the file is non-empty:

```bash
node -e "const fs=require('fs');const s=fs.statSync('server/public/vendor/marked.min.js');if(s.size<10000)process.exit(1)"
```

- [ ] **Step 2: Add the script tag to `server/public/index.html`** — modify the `<script src="/app.js">` line to be preceded by the vendor file:

Replace:
```html
  <script src="/app.js"></script>
```
with:
```html
  <script src="/vendor/marked.min.js"></script>
  <script src="/app.js"></script>
```

- [ ] **Step 3: Implement** `server/public/app.js`

```javascript
// Module-level state, render-on-event.
const state = {
  config: null,
  conversations: [],
  currentId: null,
  conversation: null
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ---- WebSocket -------------------------------------------------------------
function connectWs() {
  const wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  const ws = new WebSocket(wsUrl);
  ws.addEventListener('message', async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'turn-update' && state.currentId === msg.conversation_id) {
      state.conversation = await api('GET', `/api/conversations/${msg.conversation_id}`);
      render();
    } else if (msg.type === 'config-changed') {
      state.config = await api('GET', '/api/config');
      renderSettings();
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 1500));
}

// ---- Init ------------------------------------------------------------------
async function init() {
  state.config = await api('GET', '/api/config');
  state.conversations = await api('GET', '/api/conversations');
  if (state.conversations.length) {
    await selectConversation(state.conversations[0].id);
  }
  render();
  connectWs();
  bindEvents();
}

async function selectConversation(cid) {
  state.currentId = cid;
  state.conversation = await api('GET', `/api/conversations/${cid}`);
  render();
}

// ---- Render ----------------------------------------------------------------
function render() {
  renderSidebar();
  if (!state.conversation) {
    $('#empty').hidden = false;
    $('#conversation').hidden = true;
    return;
  }
  $('#empty').hidden = true;
  $('#conversation').hidden = false;
  const turn = state.conversation.turns.at(-1);
  $('#conv-question').textContent = turn.question;
  $('#conv-meta').innerHTML = metaHtml(turn);
  $('#stage-rail').innerHTML = stageRailHtml(turn);
  $('#stage-content').innerHTML = stageContentHtml(turn);
  bindCardClicks();
}

function renderSidebar() {
  const html = state.conversations.map((c) => `
    <button class="item ${c.id === state.currentId ? 'active' : ''}" data-id="${c.id}">
      ${escapeHtml(c.title)}
      <span class="date">${new Date(c.created_at).toLocaleString()}</span>
    </button>
  `).join('');
  $('#history').innerHTML = html || '<div class="muted" style="padding:8px">No conversations yet.</div>';
  $$('#history .item').forEach((el) => el.addEventListener('click', () => selectConversation(el.dataset.id)));
}

function metaHtml(turn) {
  const live = turn.councillors.filter((c) => c.status === 'ok').length;
  return `<span>${live}/${turn.councillors.length || (state.config?.council.length || 0)} councillors</span>
          <span>·</span>
          <span>Chairman · ${escapeHtml(state.config?.chairman || '')}</span>`;
}

function stageRailHtml(turn) {
  const stages = [
    { n: '01', t: 'First Opinions',   reached: 1, done: turn.stage >= 2 },
    { n: '02', t: 'Peer Review',       reached: 2, done: turn.stage >= 3 },
    { n: '03', t: "Chairman's Synthesis", reached: 3, done: !!turn.synthesis }
  ];
  return stages.map((s, i) => `
    <div class="stage ${turn.stage === s.reached ? 'active' : ''}">
      <div class="stage-meta"><span class="num">${s.n}</span><span>Stage</span></div>
      <div class="stage-title">${s.t}</div>
      <div class="stage-status">${s.done ? '<span class="check">✓</span> Done' : (turn.stage === s.reached ? '<span class="pulse"></span> In progress' : 'Pending')}</div>
    </div>
  `).join('');
}

function stageContentHtml(turn) {
  if (turn.stage <= 1 || turn.stage === 0) return stage1Html(turn);
  if (turn.stage === 2) return stage2Html(turn);
  return stage3Html(turn);
}

function stage1Html(turn) {
  const knownCouncil = state.config?.council || [];
  const rows = (turn.councillors.length ? turn.councillors : knownCouncil.map((c) => ({ id: c.id, status: 'thinking' })));
  return `<div class="councillors">${rows.map((c) => councillorCardHtml(c, knownCouncil)).join('')}</div>`;
}

function councillorCardHtml(c, council) {
  const meta = council.find((x) => x.id === c.id) || { vendor: 'Other', display: c.id };
  const initial = (meta.display || c.id).slice(0, 1).toUpperCase();
  if (c.status === 'ok') {
    return `
      <div class="councillor" data-id="${c.id}">
        <div class="councillor-head">
          <div class="avatar" data-vendor="${meta.vendor}">${initial}</div>
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
            <div class="vendor-tag">${meta.vendor.toLowerCase()} · ${c.id}</div>
          </div>
          <div class="latency">${c.latency_ms ? (c.latency_ms / 1000).toFixed(1) + 's' : ''}</div>
          <span class="check">✓</span>
        </div>
        <div class="response">${marked.parse(c.response || '')}</div>
        <div class="expand-row">Read full response →</div>
      </div>`;
  }
  if (c.status === 'timeout' || c.status === 'error' || c.status === 'empty' || c.status === 'unsupported_model') {
    return `
      <div class="councillor" data-id="${c.id}">
        <div class="councillor-head">
          <div class="avatar" data-vendor="${meta.vendor}">${initial}</div>
          <div class="name-block">
            <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
            <div class="vendor-tag">${meta.vendor.toLowerCase()} · ${c.id} — ${c.status}</div>
          </div>
          <span class="fail">!</span>
        </div>
        <button class="btn ghost" data-action="retry-councillor" data-id="${c.id}">Retry councillor</button>
      </div>`;
  }
  return `
    <div class="councillor" data-id="${c.id}">
      <div class="councillor-head">
        <div class="avatar" data-vendor="${meta.vendor}">${initial}</div>
        <div class="name-block">
          <div class="councillor-name">${escapeHtml(meta.display || c.id)}</div>
          <div class="vendor-tag">${meta.vendor.toLowerCase()} · ${c.id}</div>
        </div>
      </div>
      <div class="thinking-label"><span class="pulse"></span>THINKING</div>
      <div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
    </div>`;
}

function stage2Html(turn) {
  const council = state.config?.council || [];
  const rankerNodes = turn.rankings.length ? turn.rankings.map((r) => `
    <div class="councillor">
      <div class="councillor-head">
        <div class="name-block">
          <div class="councillor-name">${escapeHtml(council.find((c)=>c.id===r.ranker)?.display || r.ranker)}'s ballot</div>
          <div class="vendor-tag">${r.ranker}</div>
        </div>
      </div>
      <div class="response expanded">${marked.parse(r.raw || '')}</div>
      <div class="muted" style="margin-top:8px">Parsed: ${r.parsed.join(' › ') || '(unparseable)'}</div>
    </div>
  `).join('') : '<div class="muted">Rankings still coming in…</div>';

  const agg = turn.aggregate?.length ? `
    <div class="aggregate"><table>
      <thead><tr><th>Rank</th><th>Model</th><th>Avg position</th><th>Votes</th></tr></thead>
      <tbody>${turn.aggregate.map((a, i) => `<tr><td class="num">${i+1}</td><td>${escapeHtml(council.find((c)=>c.id===a.model)?.display || a.model)}</td><td class="num">${a.avg.toFixed(2)}</td><td class="num">${a.votes}</td></tr>`).join('')}</tbody>
    </table></div>` : '';

  return `<div class="councillors">${rankerNodes}</div>${agg}`;
}

function stage3Html(turn) {
  if (!turn.synthesis) return '<div class="muted">Chairman is synthesising…</div>';
  if (turn.synthesis.error) return `<div class="synthesis" style="border-color:var(--bad)"><div class="synthesis-label" style="color:var(--bad)">Chairman failed</div><div class="synthesis-body">${escapeHtml(turn.synthesis.error)}</div></div>`;
  return `<div class="synthesis">
    <div class="synthesis-label">Chairman · ${escapeHtml(turn.synthesis.model)}</div>
    <div class="synthesis-body">${marked.parse(turn.synthesis.text || '')}</div>
  </div>`;
}

function bindCardClicks() {
  $$('#stage-content .councillor').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      el.querySelector('.response')?.classList.toggle('expanded');
    });
  });
  $$('#stage-content [data-action="retry-councillor"]').forEach((b) => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      await api('POST', '/api/events', {
        type: 'retry-councillor',
        conversation_id: state.currentId,
        turn_id: state.conversation.turns.at(-1).id,
        councillor_id: b.dataset.id
      });
    });
  });
}

// ---- Composer (follow-ups) -------------------------------------------------
async function submitFollowUp(q) {
  await api('POST', '/api/events', {
    type: 'follow-up',
    conversation_id: state.currentId,
    question: q
  });
}

// ---- Settings drawer -------------------------------------------------------
function renderSettings() {
  if (!state.config) return;
  const cfg = state.config;
  const chair = $('#settings-chairman');
  chair.innerHTML = cfg.council.map((c) => `<option value="${c.id}" ${c.id===cfg.chairman?'selected':''}>${escapeHtml(c.display)}</option>`).join('');
  $('#settings-min').value = cfg.min_responses_to_proceed;
  $('#settings-timeout').value = cfg.councillor_timeout_seconds;
  $('#settings-councillors').innerHTML = cfg.council.map((c, i) => `
    <div class="councillor-row">
      <input data-i="${i}" data-k="display" value="${escapeHtml(c.display)}">
      <input data-i="${i}" data-k="id" value="${escapeHtml(c.id)}">
      <input data-i="${i}" data-k="vendor" value="${escapeHtml(c.vendor)}">
      <button type="button" data-remove="${i}">×</button>
    </div>
  `).join('') + '<button type="button" id="add-councillor" class="btn ghost">+ Add councillor</button>';
}

function bindEvents() {
  $('#new-conversation').addEventListener('click', async () => {
    state.currentId = null; state.conversation = null; render();
  });
  $('#open-settings').addEventListener('click', () => { $('#settings-drawer').hidden = false; renderSettings(); });
  $('#close-settings').addEventListener('click', () => { $('#settings-drawer').hidden = true; });
  $('#composer').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#composer-input').value.trim();
    if (!v || !state.currentId) return;
    $('#composer-input').value = '';
    await submitFollowUp(v);
  });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const cfg = JSON.parse(JSON.stringify(state.config));
    cfg.chairman = $('#settings-chairman').value;
    cfg.min_responses_to_proceed = Number($('#settings-min').value);
    cfg.councillor_timeout_seconds = Number($('#settings-timeout').value);
    $$('#settings-councillors .councillor-row').forEach((row, i) => {
      $$('input', row).forEach((inp) => { cfg.council[i][inp.dataset.k] = inp.value; });
    });
    try {
      await api('PUT', '/api/config', cfg);
      $('#settings-status').textContent = 'Saved. Takes effect on next question.';
    } catch (err) {
      $('#settings-status').textContent = err.message;
    }
  });
  $('#settings-councillors').addEventListener('click', (e) => {
    const rm = e.target.dataset.remove;
    if (rm !== undefined) {
      state.config.council.splice(Number(rm), 1);
      renderSettings();
    }
    if (e.target.id === 'add-councillor') {
      state.config.council.push({ id: 'new-model-id', vendor: 'Other', display: 'New Councillor' });
      renderSettings();
    }
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

init().catch((e) => console.error(e));
```

- [ ] **Step 4: Smoke test manually**

```bash
node server/start.cjs --dir /tmp/llm-council-smoke2
# Open URL, then in another terminal seed some data:
PORT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/llm-council-smoke2/state/server-info','utf8')).port)")
CONV=$(curl -sX POST -H content-type:application/json -d '{"question":"why is the sky blue?"}' http://localhost:$PORT/api/conversations | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")
TURN=$(curl -sX POST -H content-type:application/json -d '{"question":"why is the sky blue?"}' http://localhost:$PORT/api/conversations/$CONV/turns | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")
curl -sX PATCH -H content-type:application/json -d "{\"conversation_id\":\"$CONV\",\"councillors\":[{\"id\":\"claude-sonnet-4.6\",\"status\":\"ok\",\"response\":\"because Rayleigh scattering.\",\"latency_ms\":1200}]}" http://localhost:$PORT/api/turns/$TURN
# Reload the browser → councillor card should fill in live.
node server/stop.cjs --dir /tmp/llm-council-smoke2
```

(On Windows substitute `curl.exe` and `$env:TEMP` paths.)

- [ ] **Step 5: Commit**

```bash
git add server/public/app.js server/public/index.html server/public/vendor/marked.min.js
git commit -m "feat(ui): live rendering via WebSocket, settings drawer, follow-ups"
```

---
## Task 16: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create the workflow** at `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: node --version
      - run: node --test tests/
```

- [ ] **Step 2: Verify the workflow file is valid YAML locally**

Run: `node -e "const yaml = require('node:fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!yaml.includes('node --test'))process.exit(1)"`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: matrix tests on ubuntu/macos/windows × node 20/22"
```

---

## Task 17: End-to-end smoke test (no LLM calls, simulates orchestrator)

**Files:**
- Create: `tests/e2e-smoke.test.js`

Rationale: We can't test real `task` dispatch (depends on the host agent), but we can simulate the orchestrator's REST calls end-to-end and assert the server transitions and persists correctly. This catches integration bugs across all server modules.

- [ ] **Step 1: Write the failing test** at `tests/e2e-smoke.test.js`

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readJsonLine(stream) {
  return new Promise((resolve) => {
    let buf = '';
    stream.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
}

test('orchestrator can drive a full 3-stage turn end-to-end', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const server = spawn(process.execPath, [path.join(__dirname, '../server/server.cjs')], {
    env: { ...process.env, LLM_COUNCIL_DIR: tmp, LLM_COUNCIL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const info = await readJsonLine(server.stdout);
    const base = info.url;
    async function api(m, p, b) {
      const r = await fetch(base + p, { method: m, headers: b ? { 'Content-Type':'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    }

    const cfg = await api('GET', '/api/config');
    assert.ok(cfg.council.length >= 2);

    const { id: cid } = await api('POST', '/api/conversations', { question: 'q?' });
    const { id: tid } = await api('POST', `/api/conversations/${cid}/turns`, { question: 'q?' });

    // Stage 1: simulate 4 councillors completing
    const councillors = cfg.council.map((c, i) => ({ id: c.id, status: 'ok', response: `Answer from ${c.id}`, latency_ms: 1000 + i * 100 }));
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, councillors });
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, stage: 2 });

    // Stage 2: label map + rankings
    const label_map = {}; cfg.council.forEach((c, i) => { label_map[`Response ${String.fromCharCode(65 + i)}`] = c.id; });
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, label_map });
    const rankings = cfg.council.map((c) => ({
      ranker: c.id,
      raw: `Some evaluation.\n\nFINAL RANKING:\n1. Response A\n2. Response B\n3. Response C\n4. Response D`,
      parsed: ['Response A', 'Response B', 'Response C', 'Response D']
    }));
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, rankings });
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, aggregate: [{ model: cfg.council[0].id, avg: 1, votes: 4 }] });

    // Stage 3: synthesis
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, stage: 3, synthesis: { model: cfg.chairman, text: 'Final answer.' } });

    // Verify on disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'conversations', `${cid}.json`), 'utf8'));
    assert.equal(onDisk.turns[0].synthesis.text, 'Final answer.');
    assert.equal(onDisk.turns[0].rankings.length, cfg.council.length);
    assert.equal(onDisk.turns[0].councillors.length, cfg.council.length);

    // Listing surfaces it
    const list = await api('GET', '/api/conversations');
    assert.ok(list.find((c) => c.id === cid));
  } finally {
    server.kill();
  }
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test tests/e2e-smoke.test.js`
Expected: PASS.

- [ ] **Step 3: Run the full test suite to ensure nothing regressed**

Run: `node --test tests/`
Expected: PASS — all tests from Tasks 2–17.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e-smoke.test.js
git commit -m "test: end-to-end smoke covering full 3-stage flow"
```

---

## Task 18: README with install and usage

**Files:**
- Modify (replace): `README.md`

- [ ] **Step 1: Replace `README.md`** with:

```markdown
# ghcp-llm-council

A GitHub Copilot CLI skill: a panel of LLMs answers your question in parallel, peer-reviews each other anonymously, and a Chairman LLM synthesises a final answer — all visualised live in a local web UI.

Inspired by [karpathy/llm-council](https://github.com/karpathy/llm-council). Ported to ghcp CLI with no external API keys, no build step, and a self-contained Node server.

## How it works

1. You ask the council a question.
2. **Stage 1** — N councillor models answer in parallel, each in isolation.
3. **Stage 2** — every councillor sees the others' anonymised answers and ranks them.
4. **Stage 3** — a Chairman model synthesises a final answer using all responses + rankings.

You watch it unfold at a local URL with live updates, and you can ask follow-ups either in the terminal or in the browser composer.

## Install

```bash
git clone https://github.com/USER/ghcp-llm-council.git ~/.copilot/skills/llm-council
```

Requires Node 20+ and ghcp CLI. No `npm install` step — the server has zero npm dependencies.

## Usage

In any ghcp CLI session, just ask:

> ask the council why Python uses indentation for blocks

The skill spins up a local server, opens a tab at `http://localhost:<random-port>`, dispatches the council, and shows live progress. Persisted to `<cwd>/.llm-council/conversations/`.

Add `.llm-council/` to your repo's `.gitignore`.

## Configuration

Defaults live in `defaults/council.json`. Override per-repo by editing `<cwd>/.llm-council/state/council.json` — or click the gear icon in the UI.

```json
{
  "council": [
    {"id": "claude-sonnet-4.6", "vendor": "Anthropic", "display": "Claude Sonnet 4.6"},
    {"id": "claude-opus-4.7",   "vendor": "Anthropic", "display": "Claude Opus 4.7"},
    {"id": "gpt-5.2",           "vendor": "OpenAI",    "display": "GPT-5.2"},
    {"id": "gpt-5.3-codex",     "vendor": "OpenAI",    "display": "GPT-5.3 Codex"}
  ],
  "chairman": "claude-opus-4.7",
  "min_responses_to_proceed": 2,
  "councillor_timeout_seconds": 120
}
```

The `id` must match a model the ghcp CLI `task` tool supports.

## First-60-seconds smoke test

1. Clone into `~/.copilot/skills/llm-council/`.
2. Start a ghcp CLI session in any directory.
3. Type "ask the council: what is the capital of France?".
4. Verify the browser opens, all 4 default councillors finish, all 3 stages complete, browser shows synthesis.
5. Verify `<cwd>/.llm-council/conversations/*.json` exists.

## Development

```bash
node --test tests/          # run all tests
node --test --watch tests/  # watch mode
node server/start.cjs       # launch server standalone for UI dev
node server/stop.cjs        # tear down
```

## License

MIT
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README with install, usage, configuration"
```

---

## Task 19: Cross-platform sanity sweep and final test run

**Files:**
- Modify: any platform-specific fixes uncovered

- [ ] **Step 1: Run the full test suite once more**

Run: `node --test tests/`
Expected: ALL PASS (a few hundred assertions across ~10 files).

- [ ] **Step 2: Verify Windows-friendliness manually**

If on Windows: run the smoke test from Task 15's Step 4 using PowerShell, substituting `$env:TEMP\llm-council-smoke` for `/tmp/...`. Verify:
- Server starts and `state/server-info` is written.
- Browser loads at the printed URL.
- A PATCH from `curl.exe` causes the WebSocket to push and the browser to refresh.
- `node server/stop.cjs --dir $env:TEMP\llm-council-smoke` cleanly terminates the server.

If any path/separator/shell issue surfaces, patch in `server/start.cjs` or `server/stop.cjs` using `path.join` (already used) and `process.execPath`.

- [ ] **Step 3: Run the spec → plan coverage check**

Open `docs/superpowers/specs/2026-05-29-llm-council-skill-design.md` and confirm every section/requirement maps to a task:

| Spec section | Tasks |
|---|---|
| §3 architecture | Tasks 1, 7, 10, 13 |
| §4.1 SKILL.md | Task 13 |
| §4.2 Server | Tasks 7, 8, 9, 10 |
| §4.3 Browser app | Tasks 14, 15 |
| §4.4 Prompts | Task 12 |
| §4.5 Defaults | Task 4 |
| §4.6 Repo layout | Task 1 |
| §5 Data flow | Tasks 8, 13, 15 |
| §6 Error handling | Tasks 4 (config), 13 (SKILL.md), 15 (UI retries) |
| §7 TDD discipline | Tasks 2–11 (all test-first) |
| §7.4 CI | Task 16 |
| §7.5 Smoke test | README in Task 18, E2E in Task 17 |

- [ ] **Step 4: Tag the v0.1.0 release commit**

```bash
git tag -a v0.1.0 -m "v0.1.0 — initial LLM Council skill"
```

- [ ] **Step 5: Final commit (if anything changed in Steps 1–3)**

```bash
git status
# If clean: nothing to do.
# If changes: git add -A && git commit -m "chore: cross-platform sweep and final test run"
```

---

## Done

When all tasks above are complete and committed:

- `node --test tests/` passes on Ubuntu, macOS, Windows × Node 20/22 (CI green)
- Manual smoke test in `README.md` works end-to-end
- Repo is ready to push to `github.com/USER/ghcp-llm-council` and clone into `~/.copilot/skills/llm-council/`

