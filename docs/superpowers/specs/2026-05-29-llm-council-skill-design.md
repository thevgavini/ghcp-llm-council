# ghcp-llm-council — Design Spec

**Date:** 2026-05-29
**Status:** Approved for implementation planning
**Author:** Brainstormed via Copilot CLI brainstorming skill

---

## 1. Summary

`ghcp-llm-council` is a GitHub Copilot CLI skill that brings Andrej Karpathy's [LLM Council](https://github.com/karpathy/llm-council) pattern to ghcp CLI: when the user asks a question, multiple LLMs answer in parallel, peer-review each other's anonymized responses, and a designated Chairman model synthesizes a final answer. The skill ships with a self-contained vanilla-JS web UI (served by a built-in Node server) so the user can watch the deliberation unfold in their browser at a local URL, while remaining inside the ghcp CLI for follow-ups.

It differs from Karpathy's reference implementation in three deliberate ways:

1. **No external API key.** All model calls go through ghcp CLI's native `task` tool with per-call model overrides, consuming the user's existing Copilot inference budget — no OpenRouter, no vendor keys.
2. **Self-contained skill, no external dependencies.** Server, UI, prompts, defaults all ship inside the skill repo. Vanilla HTML/CSS/JS — no React, no Vite, no build step.
3. **Orchestrator/server split.** The Copilot CLI agent itself is the orchestrator (dispatching `task` agents and POSTing results to the server). The server is "dumb about LLMs" — it never calls a model. This separation lets the orchestration logic live in `SKILL.md` as agent-readable instructions, while the server owns all UI state and persistence.

## 2. Goals and non-goals

### Goals
- Feature parity with Karpathy's LLM Council: 3-stage deliberation, anonymized peer review, aggregate rankings, chairman synthesis, conversation history sidebar, in-browser configuration.
- Refined, polished UI worth shipping publicly (Linear-adjacent visual quality).
- Zero install friction beyond `git clone` — no `npm install`, no `pip install`, no API keys.
- Cross-platform (Windows, macOS, Linux) by default; document caveats where they exist.
- Graceful degradation on partial failure (mark dead councillors, continue with survivors, never fail the whole deliberation if at least 2 councillors respond).

### Non-goals
- Per-token streaming from individual councillors. Progressive reveal as each `task` agent finishes is what we ship; true token streaming would require bypassing `task` and calling vendor APIs directly, which we've explicitly chosen not to do.
- Claude Code support as a first-class target for v1. The skill targets ghcp CLI exclusively for v1; Claude Code compatibility is documented as "works with caveats" and remains a future improvement.
- Marketplace integration. Install is `git clone` into `~/.copilot/skills/llm-council/`.
- Any model inference inside the server. The server is a coordinator and persistence layer only.

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ghcp-llm-council                             │
│                       installed skill repo                          │
└─────────────────────────────────────────────────────────────────────┘
              │                                          │
              ▼                                          ▼
   ┌────────────────────┐                    ┌────────────────────┐
   │   SKILL.md         │                    │   server/          │
   │   (orchestrator    │                    │   server.cjs       │
   │    instructions    │                    │   public/          │
   │    for ghcp CLI)   │                    │     index.html     │
   │                    │                    │     app.css        │
   │   prompts/         │                    │     app.js         │
   │     councillor.md  │                    │   defaults/        │
   │     ranker.md      │                    │     council.json   │
   │     chairman.md    │                    │                    │
   └────────────────────┘                    └────────────────────┘
              │                                          │
              │ tells the agent to:                      │ runs as long-lived
              │  1. start server                         │ Node process per session
              │  2. dispatch task agents per stage       │ (~30 min idle timeout)
              │  3. POST results to server REST API      │
              │  4. read state_dir/events on follow-ups  │
              ▼                                          ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  Running session (under <cwd>/.llm-council/)                   │
   │  ├─ state/                                                     │
   │  │   ├─ server-info       (URL, port, pid)                     │
   │  │   ├─ server.pid                                             │
   │  │   ├─ server.log                                             │
   │  │   ├─ events             (browser → orchestrator, JSONL)     │
   │  │   └─ council.json       (runtime config, overrides defaults)│
   │  └─ conversations/                                             │
   │      ├─ <conv-id>.json    (full persisted conversation)        │
   │      └─ ...                                                    │
   └────────────────────────────────────────────────────────────────┘
```

**Roles:**

- **SKILL.md** — instructions for the Copilot CLI agent. The actual orchestrator. Contains the 3-stage loop and references the 3 prompt templates.
- **Node server** — stateful in-memory session + persistence layer. Exposes REST + WebSocket to the browser. Exposes REST to the orchestrator. Knows nothing about LLMs.
- **Browser UI** — vanilla HTML/CSS/JS. Subscribes to WebSocket, renders state, posts user actions (config edits, follow-up questions, drill-down requests) back to the server.
- **`.llm-council/` per-repo folder** — all session data, configs, persisted conversations. Users add it to `.gitignore`.

The separation that matters: the server is dumb about LLMs; the orchestrator is dumb about UI rendering. The server's API is the contract between them.

## 4. Components

### 4.1 SKILL.md (orchestrator instructions)

Single markdown file containing:

- **Trigger description** at the top — "Use when user asks the council, requests a panel / multi-model opinion, wants several models to weigh in on a question".
- **Lifecycle section** — how to detect or start the server. `scripts/start.cjs` returns `{port, url, session_dir}` as JSON on first startup; this is cached in `state/server-info` for subsequent invocations.
- **The 3-stage loop** — explicit, numbered steps. For each stage: which `task` models to dispatch, which prompt file to use, which REST endpoint to POST results to.
- **Follow-up handling** — instructions to read `state/events` on each new turn so browser-initiated actions get processed.
- **3 prompt templates** referenced as `prompts/councillor.md`, `prompts/ranker.md`, `prompts/chairman.md`. Kept separate so prompts are editable without touching the orchestration loop.

### 4.2 Server (`server/server.cjs`)

Single Node file, zero npm dependencies. Three responsibilities:

1. **HTTP server** — serves `public/*` static files + REST API under `/api`.
2. **WebSocket server** — RFC 6455 implementation (vanilla, ~100 lines), broadcasts state changes to connected browsers.
3. **Filesystem watcher** — watches `state/events` so browser-side actions get captured durably (survives orchestrator turns).

REST surface (all under `/api`):

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/config` | Current council config (members, chairman) |
| `PUT`  | `/config` | Browser saves config edits |
| `GET`  | `/conversations` | History sidebar list |
| `GET`  | `/conversations/:id` | Full conversation for restore |
| `POST` | `/conversations` | Orchestrator creates new conversation |
| `POST` | `/conversations/:id/turns` | Orchestrator starts a new turn (question) |
| `PATCH`| `/turns/:tid` | Orchestrator updates turn state (stage, councillor responses, rankings, synthesis) |
| `POST` | `/events` | Browser posts user actions (follow-up, retry councillor, edit config, drill-down) |

WS events server → browser: `session-state`, `turn-update`, `councillor-update`, `config-changed`, `pending-input`.

### 4.3 Browser app (`server/public/`)

Three files, no build step:

- **`index.html`** — shell layout: brand mark, history sidebar (toggleable), main pane, settings drawer.
- **`app.css`** — design tokens + components per the approved mockup. Inter typeface from a CDN with system-font fallback. Light + dark themes via `prefers-color-scheme`. Restrained violet accent. Skeleton shimmer for loading.
- **`app.js`** — single ~300-line file: WebSocket subscription, render functions per section, REST helpers, markdown rendering via a tiny vendored library (e.g. `marked`).

State management: a module-level `state` object + a `render()` function called on every WS message. No framework, no virtual DOM — the UI surface is small enough not to need one.

### 4.4 Prompts (`prompts/`)

Three markdown files, lifted from Karpathy's `council.py` with minimal edits to enforce the no-tools constraint:

- **`councillor.md`** — system prompt prepended to the user's question. Encodes the strict "answer from your knowledge only, do not read files, do not use any tools" framing and a length guideline.
- **`ranker.md`** — the anonymized A/B/C/D ranking prompt with the strict `FINAL RANKING:` format requirement (Karpathy's exact format).
- **`chairman.md`** — synthesis prompt receiving question + all stage-1 responses + all stage-2 raw rankings.

### 4.5 Defaults (`defaults/council.json`)

Ships with a sensible default council drawn from the models exposed by ghcp CLI's `task` tool:

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

User's runtime config lives at `<cwd>/.llm-council/state/council.json`. Defaults are loaded only when runtime config is absent.

### 4.6 Repo layout

```
ghcp-llm-council/
├── SKILL.md
├── README.md
├── LICENSE                  (MIT)
├── .gitignore
├── prompts/
│   ├── councillor.md
│   ├── ranker.md
│   └── chairman.md
├── server/
│   ├── server.cjs
│   ├── start.cjs            (launcher: random port, writes server-info JSON)
│   ├── stop.cjs
│   └── public/
│       ├── index.html
│       ├── app.css
│       └── app.js
├── defaults/
│   └── council.json
└── tests/
    ├── fixtures/
    └── *.test.js            (Node's built-in test runner)
```

## 5. Data flow

### 5.1 First-time invocation ("ask the council why X")

1. Orchestrator matches trigger phrase, loads `SKILL.md`, follows lifecycle section.
2. Lifecycle check: does `<cwd>/.llm-council/state/server-info` exist and is its PID alive?
   - Yes → reuse, read URL.
   - No → spawn `server/start.cjs` in background, wait for `server-info` JSON.
3. `POST /api/conversations` → server returns `{conversation_id}`. `POST /api/conversations/:cid/turns` with `{question}` → returns `{turn_id}`.
4. Orchestrator tells user: "Council convened at http://localhost:PORT — opening 4 stage-1 opinions."
5. **Stage 1:** dispatch N `task` agents in parallel (background mode), one per councillor. Prompt = `prompts/councillor.md` + the user's question. Each agent has a different `model` override; tool use is forbidden per councillor.md.
6. As each `task` completes (orchestrator receives one completion notification per agent): `PATCH /api/turns/:tid { councillor_id, stage: 1, response, latency_ms }` → server stores it, broadcasts WS `councillor-update` → browser fills in that card with skeleton-to-content transition.
7. When ≥ `min_responses_to_proceed` councillors are done (or all have timed out): `PATCH /api/turns/:tid { stage: 2 }` → browser switches active tab.
8. **Stage 2:** dispatch one `task` agent per *surviving* councillor with the anonymized ranker prompt + all stage-1 responses labeled A/B/C/D. Anonymization mapping kept in orchestrator state only (never sent to ranker agents).
9. As each ranking returns: orchestrator parses `FINAL RANKING:` with Karpathy's regex (numbered list, falling back to any `Response [A-Z]` matches). `PATCH /api/turns/:tid { ranker_id, stage: 2, raw, parsed_ranking }` → browser fills tab 2. After all rankings in, orchestrator computes aggregate (average position per model). `PATCH /api/turns/:tid { stage: 2_complete, aggregate }` → browser shows aggregate table.
10. **Stage 3:** single `task` agent (chairman model from config) with chairman prompt receiving question + all stage-1 responses + all stage-2 raw text. `PATCH /api/turns/:tid { stage: 3, synthesis }` → tab 3 fills, header transitions to "Done."
11. Server persists the completed turn to `<cwd>/.llm-council/conversations/<cid>.json`.

### 5.2 Follow-up question

**Browser path:** user types in browser composer → browser `POST /api/events { type: 'follow-up', conversation_id, question }` → server appends JSON line to `state/events` AND broadcasts `pending-input` on WS → orchestrator notices on next turn (by reading `state/events`) and dispatches a new turn (resume at step 5.1 #3).

**Terminal path:** user just types follow-up in chat → orchestrator detects "still inside a council session" (server-info present + recent `conversation_id` cached in session) → same flow.

### 5.3 Config edit from browser

User opens settings drawer, edits councillor list, clicks Save → browser `PUT /api/config { council, chairman, ... }` → server writes `<cwd>/.llm-council/state/council.json`, broadcasts `config-changed` → orchestrator reads updated config at the start of the next turn. Mid-turn edits do not take effect retroactively; UI shows a "Config saved, takes effect on next question" banner.

### 5.4 Drill-down ("ask councillor X directly")

User clicks "ask Claude Opus a follow-up" on a card → browser `POST /api/events { type: 'drill', councillor_id, conversation_id, question }` → orchestrator reads on next turn, dispatches a single `task` agent with that model only → `PATCH /api/turns/:tid { drill: {councillor_id, response} }` when done → browser renders a thread under that councillor card.

### 5.5 Persistence shape (`conversations/<id>.json`)

```jsonc
{
  "id": "conv_8f3a...",
  "created_at": "2026-05-29T19:30:00Z",
  "title": "Why does Python use indentation",
  "turns": [
    {
      "id": "turn_01",
      "question": "...",
      "councillors": [
        {"id":"claude-sonnet-4.6","status":"ok","latency_ms":7200,"response":"..."},
        {"id":"gpt-5.2","status":"ok","latency_ms":5800,"response":"..."},
        {"id":"claude-opus-4.7","status":"timeout","error":"..."}
      ],
      "rankings": [
        {"ranker":"claude-sonnet-4.6","raw":"...","parsed":["Response B","Response A"]}
      ],
      "label_map": {"Response A":"claude-sonnet-4.6","Response B":"gpt-5.2"},
      "aggregate": [{"model":"gpt-5.2","avg":1.33,"votes":3}],
      "synthesis": {"model":"claude-opus-4.7","text":"..."},
      "drills": [{"councillor":"gpt-5.2","question":"...","response":"..."}]
    }
  ]
}
```

## 6. Error handling

### 6.1 Councillor task agent failures

| Failure | Detection | Response |
|---|---|---|
| Agent timeout (> `councillor_timeout_seconds`) | Per-agent timer in orchestrator | Mark `status: "timeout"`, PATCH server, card shows ⚠ with "Retry" button |
| Agent returns empty / garbage | Sanity check: non-empty, > 20 chars | Mark `status: "empty"`, same UI |
| Agent errors (rate limit, infra) | Read agent result | Mark `status: "error"`, expose error message in card details |
| All councillors fail in Stage 1 | After dispatch, if 0 succeed | Skip Stages 2 & 3; show error in UI; offer "Retry All" button |
| Fewer than `min_responses_to_proceed` succeed | Configurable threshold (default 2) | Same as all-fail path; user can lower threshold + retry |

**Retry semantics:** User clicks Retry on a failed councillor → orchestrator re-dispatches just that one. If it succeeds *after* Stage 2 has already started, its response is added to the persisted turn but does NOT re-trigger Stage 2 (would invalidate other rankings). UI clearly labels it "late response, not included in peer review".

### 6.2 Stage 2 ranking failures

| Failure | Response |
|---|---|
| Ranker times out / errors | Mark that ranker's vote missing; aggregate computed from surviving ballots |
| Ranker output doesn't contain `FINAL RANKING:` | Fallback regex extracts any `Response [A-Z]` matches in order (Karpathy's fallback) |
| Ranker output has zero parseable rankings | Mark ranker `status: "unparseable"`, exclude from aggregate, show raw text in tab |
| Zero successful rankings | Skip aggregate; chairman runs with raw stage-1 responses + a note "no peer rankings available" |

### 6.3 Chairman failure

Show error in Stage 3 tab + "Retry Chairman" button. Offer "Choose different chairman" inline picker.

### 6.4 Server failures

| Failure | Detection | Response |
|---|---|---|
| Server crashes mid-turn | Next REST call from orchestrator errors | Attempt restart via `start.cjs`. If success, re-POST in-flight turn state from orchestrator memory. If restart fails, fall back to terminal: post council results as markdown in chat, persist nothing. |
| Port already in use | Startup error | Server retries with new random port |
| Server killed by user / OS | PID check fails | Orchestrator detects on next turn, restarts cleanly, surfaces "Council UI was offline — restarted at NEW_URL" |
| Conversation file write fails | Server logs warning | Live session continues; warning visible in browser footer; user can manually export from UI |

### 6.5 Browser disconnections

| Scenario | Behavior |
|---|---|
| WebSocket drops | Browser auto-reconnects with exponential backoff; on reconnect, fetches full conversation state via REST and re-renders |
| Browser tab closed | No effect on session — server keeps running, conversation persists, terminal flow continues |
| User reopens browser after disconnect | Restores latest conversation by default; history sidebar populated from `/api/conversations` |

### 6.6 Misconfigurations

| Scenario | Behavior |
|---|---|
| `council.json` references a model `task` tool doesn't support | Orchestrator validates against the known model list at session start; flags invalid IDs in browser footer; skips those councillors, alerts user |
| `council.json` is malformed JSON | Server refuses to start session for that file; surfaces error; user can edit in browser or fix file directly |
| Chairman model is also in council list | Allowed (matches Karpathy); the chairman is both councillor and synthesizer for that question |
| Only one councillor configured | Refuse; council needs ≥ 2 members. Surface in browser with link to settings. |

### 6.7 Concurrency

| Scenario | Behavior |
|---|---|
| Two ghcp sessions in same cwd | Second invocation detects existing server-info, reuses server. Both sessions can post turns concurrently — server routes by `conversation_id`. |
| User edits config while turn in flight | Server accepts, but orchestrator finishes current turn with old config; next turn uses new. Browser banner: "Config saved, takes effect on next question." |

## 7. Testing

**Discipline: test-driven development.** Every server module and pure function is written test-first: write the failing test, implement until it passes, refactor. The plan generated from this spec will sequence work as red-green-refactor cycles, not as "implement then test".

### 7.1 What's testable, what isn't

**Testable in isolation:**

- Server REST endpoints (spin up real server, hit endpoints, assert responses)
- WebSocket protocol (connect, subscribe, assert broadcasts)
- Filesystem watcher for `state/events`
- Conversation persistence round-trip (write → read → assert shape)
- Config validation (malformed JSON, unknown model IDs, < 2 councillors)
- Ranking parser (Karpathy's regex + fallback) against fixture strings
- Aggregate computation (deterministic, pure function)
- Lifecycle: PID check, idle timeout, port retry

**Out of automated test scope, covered by manual smoke test:**

- The SKILL.md flow itself — depends on the host agent following instructions correctly. Documented manual walkthrough in README.
- Browser UI rendering — vanilla JS, no React DevTools. Visual QA. Playwright can be added later if it becomes pain.
- `task` agent behavior — depends on model availability and ghcp CLI version.

### 7.2 Test setup

- **Runner:** Node's built-in `node --test` (Node 20+). No Jest, no Mocha — keeps dependencies zero, matches the "ship natively" goal.
- **Location:** `tests/` at repo root.
- **No mocks for the server:** spin up the real server on a random port per test, hit it with `fetch()` / `WebSocket`, tear down.
- **Fixtures:** `tests/fixtures/` for prompts, parsed-ranking strings (including malformed cases), sample `council.json` files.

### 7.3 Initial test coverage

```
server lifecycle
  ✓ starts on random port, writes server-info JSON
  ✓ refuses to start if specified port taken; retries random
  ✓ shuts down on SIGTERM, removes server-info, writes server-stopped
  ✓ exits after IDLE_TIMEOUT with no activity

REST API
  ✓ POST /api/conversations creates with id + timestamp
  ✓ POST /api/conversations/:cid/turns appends turn
  ✓ PATCH /api/turns/:tid updates and broadcasts WS message
  ✓ GET /api/conversations lists in reverse chrono
  ✓ PUT /api/config validates, rejects malformed, writes file
  ✓ POST /api/events appends to state/events

WebSocket
  ✓ broadcasts turn-update to all connected clients
  ✓ client fetches full state via REST on reconnect

Persistence
  ✓ turn written to disk on PATCH stage:3
  ✓ partial turns NOT persisted (only completed)
  ✓ conversation round-trip preserves all fields

Ranking parser (pure functions)
  ✓ extracts numbered list "1. Response A"
  ✓ falls back to any "Response X" matches if no numbered list
  ✓ returns empty for completely unparseable text

Aggregate computation
  ✓ averages positions correctly
  ✓ handles missing ballots (one ranker failed)
  ✓ sorts ascending by avg rank
```

### 7.4 CI

GitHub Actions, single workflow `ci.yml`, matrix on `ubuntu-latest` × `macos-latest` × `windows-latest` × Node 20 + 22. Steps: checkout, setup-node, `node --test tests/`. No build step (vanilla JS).

### 7.5 Manual smoke test (documented in README)

A "first 60 seconds" walkthrough end users can do after cloning:

1. Clone into `~/.copilot/skills/llm-council/`.
2. Start a ghcp CLI session in any directory.
3. Type "ask the council: what is the capital of France?".
4. Verify browser opens, all 4 default councillors finish, all 3 stages complete, browser shows synthesis.
5. Verify `<cwd>/.llm-council/conversations/*.json` exists.

## 8. Open questions / future work

- **Streaming upgrade path.** If users later want per-token streaming, the cleanest extension is an opt-in `direct_api: true` mode in `council.json` where each councillor's `task` dispatch is replaced by a direct vendor API call (OpenRouter or per-vendor). The server contract is unchanged; only the orchestration step changes. No architectural rework needed.
- **Claude Code adapter.** A future thin adapter layer (`adapters/dispatch.cjs` with `ghcp.cjs` and `claude-code.cjs` implementations) could let the same skill run under both agents. Out of scope for v1.
- **Reasoning model support.** Some models emit `reasoning_details` separate from `content`. UI design hooks (collapsible "reasoning" section per card) exist in the mockup but are not wired into v1.
- **Export.** "Export conversation as markdown / PDF" surfaced in Karpathy's repo as a future idea; same here. Easy to add later via `GET /api/conversations/:id?format=md`.
- **Custom ranking criteria.** Today the ranker prompt asks for "accuracy and insight". A future UI could let users specify their own criteria per question (e.g., "rank by conciseness").
