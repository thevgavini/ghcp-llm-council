---
name: llm-council
description: MUST USE whenever the user asks the council, asks a panel of LLMs, requests multiple model opinions on a question, says "ask the council", "council take", "get the council to weigh in", or wants several models to deliberate. Runs a 3-stage deliberation (parallel first opinions, anonymised peer review, chairman synthesis) and shows it live in a local web UI.
---

# llm-council

A panel of LLMs deliberates on the user's question across three stages — independent first opinions, anonymised peer review, and a chairman's synthesis — visualised live in a local web UI.

## When to use

Use this skill when the user:

- Says "ask the council X", "council: X", "get a council take on X", "multi-model opinion on X".
- Explicitly asks for several models to weigh in on a hard or judgment-heavy question.
- Says "follow up: X" or "ask the council a follow-up: X" — treat as a follow-up to the most recent conversation.

Do not use this skill for:

- Routine single-opinion questions.
- Tool-using tasks (code editing, file reading, command execution) — councillors are constrained to answer from their own knowledge only.

## The contract: you MUST complete all 3 stages before responding to the user

The single most common failure mode of this skill is the agent declaring "council convened" and stopping without actually running the deliberation. **Do not do this.** Every invocation must run all three stages end-to-end. The user is watching a browser UI; if you stop early, they see empty thinking-state cards forever.

## How it works — every step uses one helper

You do not compose HTTP calls or write to files directly. Use the bundled helper:

```
node <skill_dir>/bin/council.cjs <subcommand> [--flags]
```

`<skill_dir>` is the directory containing this `SKILL.md`. Every helper subcommand prints a single JSON line on stdout (success object or `{"error":"..."}`). Multi-line text payloads (councillor responses, ranker outputs, synthesis) are read from **stdin** to avoid shell escaping issues.

## The mandatory loop

### Step 0 — Initialise (starts server, creates conversation + turn)

```
node <skill_dir>/bin/council.cjs init --question "<the user's exact question>"
```

Parse the JSON output. You'll need: `url`, `conversation_id`, `turn_id`, `council` (array of councillors with `id`, `display`, `vendor`), `chairman` (model id), `councillor_timeout_seconds`, `min_responses_to_proceed`.

Tell the user once: **"Council convened at \<url\>. Watch live as the deliberation unfolds."**

> If the user said "follow up" / "ask a follow-up", use `follow-up --question "..." --cid <previous conversation id>` instead of `init`. The previous conversation id is in your scratchpad from the prior invocation in this session, or you can list via `status` and pick the most recent.

### Step 1 — First opinions (parallel `task` dispatches)

For **each** councillor in the `council` array, dispatch a `task` sub-agent in **background** mode:

- `model` = the councillor's `id` (e.g. `claude-sonnet-4.6`)
- `agent_type` = `general-purpose`
- `mode` = `background`
- `prompt` = the entire contents of `<skill_dir>/prompts/councillor.md` + a blank line + the user's exact question

**Dispatch all councillors in a single response** (parallel tool calls). Then wait for completion notifications.

As each councillor returns, immediately PATCH the server:

```powershell
# Windows PowerShell — pipe the response to stdin
$response | node <skill_dir>/bin/council.cjs patch-councillor `
  --tid <turn_id> --cid <conversation_id> `
  --id <model id> --status ok --latency-ms <elapsed>
```

```bash
# Unix
printf '%s' "$response" | node <skill_dir>/bin/council.cjs patch-councillor \
  --tid <turn_id> --cid <conversation_id> \
  --id <model_id> --status ok --latency-ms <elapsed>
```

If a sub-agent times out (> `councillor_timeout_seconds`), returns empty/garbage, or errors, PATCH it with `--status timeout|empty|error` and pipe the error message to stdin. The browser will show the failed card and offer retry.

Once `min_responses_to_proceed` councillors have succeeded (default: 2 out of 4), advance:

```
node <skill_dir>/bin/council.cjs advance --tid <turn_id> --cid <conversation_id> --stage 2
```

If fewer than `min_responses_to_proceed` succeed, advance to `--stage -1` and stop. Tell the user the council failed and ask whether to retry.

### Step 2 — Anonymised peer review (parallel `task` dispatches)

Build a label map mapping `Response A`, `Response B`, … to each surviving councillor's `id`, in the order they appear in `council`. Push it to the server:

```
node <skill_dir>/bin/council.cjs set-label-map --tid <turn_id> --cid <conversation_id> --map '{"Response A":"claude-sonnet-4.6","Response B":"claude-opus-4.7","Response C":"gpt-5.2","Response D":"gpt-5.3-codex"}'
```

For **each** surviving councillor (acting now as a ranker), dispatch a `task` sub-agent in **background** mode with `model` = that councillor's id and `prompt` built from `<skill_dir>/prompts/ranker.md`:

- Replace `{{QUESTION}}` with the user's exact question.
- Replace `{{RESPONSES}}` with the labelled responses joined by blank lines:
  ```
  Response A:
  <text from councillor A>

  Response B:
  <text from councillor B>

  ...
  ```

**Dispatch all rankers in a single response** (parallel tool calls). Wait for completions.

As each ranking returns, PATCH:

```powershell
$rankingText | node <skill_dir>/bin/council.cjs patch-ranking `
  --tid <turn_id> --cid <conversation_id> `
  --ranker <model_id>
```

(The helper parses the `FINAL RANKING:` section automatically using the same regex as the test suite. Pass `--parsed '[...]'` only if you've already parsed it yourself.)

Once all rankings are in (or all timed out), compute and PATCH the aggregate:

```
node <skill_dir>/bin/council.cjs aggregate --tid <turn_id> --cid <conversation_id>
```

### Step 3 — Chairman synthesis (single `task` dispatch)

Dispatch one `task` sub-agent with `model` = the `chairman` id from init's output. Build the prompt from `<skill_dir>/prompts/chairman.md`:

- Replace `{{QUESTION}}` with the user's exact question.
- Replace `{{STAGE1}}` with a concatenation, each councillor formatted as:
  ```
  Model: <councillor_id>
  Response: <text>

  ```
- Replace `{{STAGE2}}` with each ranker formatted as:
  ```
  Model: <ranker_id>
  Ranking: <raw ranking text>

  ```

When the chairman returns, PATCH the synthesis (this also persists the conversation to disk):

```powershell
$synthesis | node <skill_dir>/bin/council.cjs synthesize `
  --tid <turn_id> --cid <conversation_id> `
  --model <chairman_id>
```

### Step 4 — Respond to the user

After Step 3 completes, tell the user:

> "Synthesis ready at \<url\>. Final answer below."

Then paste the chairman's synthesis as markdown in the chat. Brief one-line summary of how the council ranked the councillors is welcome.

**You are NOT done before this step.**

## Follow-ups

When the user says "follow up: X" or similar, treat as a new turn on the most recent conversation:

```
node <skill_dir>/bin/council.cjs follow-up --question "X" --cid <previous_conversation_id>
```

Then run Steps 1–4 exactly as above. Each turn is independent — councillors do not see prior turns' content. (This matches Karpathy's reference design.)

## Reading browser-side events (optional, advanced)

If you want to support a future browser-initiated input mode, you can periodically read the events file:

```
node <skill_dir>/bin/council.cjs read-events
```

Returns `{"events":[...]}` and truncates the file. For v0.1 this is empty (the browser has no composer); leave it for future iteration.

## Failure handling

- **All councillors fail Stage 1.** Advance to `--stage -1` with an error PATCH on the turn. Tell the user; ask whether to retry.
- **Some councillors fail.** Continue with survivors as long as `min_responses_to_proceed` is met. Browser shows failed cards with retry buttons (browser-initiated retry is not wired in v0.1 — the user can re-ask in the CLI).
- **A ranker's text is unparseable** (no `FINAL RANKING:` section + no fallback matches). The helper's parser handles this — it returns an empty array, which the aggregator silently excludes. The raw text stays visible in the UI.
- **Chairman fails.** Re-dispatch once. If it fails twice, synthesise a short notice ("Chairman failed; raw councillor responses and rankings are available above") and PATCH that as the synthesis text so the conversation can still persist.
- **Server died mid-loop.** `init` will detect and restart on next call. For in-flight state loss, re-init with the same question (a duplicate conversation is acceptable; the user can delete from the sidebar later — that UX doesn't exist yet, so just acknowledge in chat).
- **Config references a `task` model you don't support.** PATCH the councillor with `--status error` and a message; continue with the rest. Tell the user to edit `<cwd>/.llm-council/state/council.json` (or `<skill_dir>/defaults/council.json`).

## Quick command reference

| Helper | Purpose |
|---|---|
| `init --question "..."` | Start server (if needed), create conversation + turn, return ids + council config |
| `follow-up --question "..." --cid <cid>` | New turn on existing conversation |
| `patch-councillor --tid X --cid Y --id <model> --status ok --latency-ms N` (stdin: response) | Push one councillor's response |
| `advance --tid X --cid Y --stage N` | Transition turn to next stage |
| `set-label-map --tid X --cid Y --map '{...}'` | Set anonymisation map (server keeps this) |
| `patch-ranking --tid X --cid Y --ranker <model>` (stdin: raw text) | Push one ranking; parser runs automatically |
| `aggregate --tid X --cid Y` | Compute + PATCH aggregate rankings |
| `synthesize --tid X --cid Y --model <chairman>` (stdin: synthesis md) | PATCH stage 3, persists to disk |
| `read-events` | Drain browser-side events file (v0.2 feature) |
| `status` | Show server info + conversation count |

## Per-session state lives under `<cwd>/.llm-council/`

```
.llm-council/
  state/
    server-info     (URL, port, pid)
    server.pid
    server.log
    events          (JSONL, browser-side events for future use)
    council.json    (runtime config override)
  conversations/
    <conv-id>.json  (persisted on PATCH stage:3)
```
