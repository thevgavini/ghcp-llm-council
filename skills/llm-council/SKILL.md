---
name: llm-council
description: Use when the user asks the council, requests a panel of LLMs, wants multiple models to weigh in, says "ask the council X", "council take on Y", or "multi-model opinion on Z". Runs a 3-stage deliberation (parallel first opinions, anonymised peer review, chairman synthesis) with a live web UI.
---

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
