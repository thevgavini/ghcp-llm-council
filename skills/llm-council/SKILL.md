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

## Two backends per councillor

Each councillor (and the chairman) has a `backend` field:

- **`task`** — dispatched by you via the `task` tool with `model` set to the councillor's `id`. Use this for Anthropic + OpenAI models exposed through ghcp CLI. No extra credentials needed (uses the user's Copilot inference).
- **`github-models`** — dispatched via the helper's `call` subcommand, which posts to `models.github.ai/inference/chat/completions` using the user's `gh auth token`. No extra credentials beyond `gh auth login`. Use this for Meta Llama, DeepSeek, Mistral, Microsoft Phi, Cohere — vendors NOT exposed through `task`.

The default council mixes both backends. Inspect the `council` array from `init`'s output: each entry has `id`, `vendor`, `display`, `backend`.

## Modes — pick the right prompt set for the question

Five modes are available; each ships its own `councillor` and `chairman` prompts tuned for the question shape:

| Mode | Use when the user asks for… | Triggering language |
|---|---|---|
| `general` (default) | Open-ended Q&A, explanations, opinions | "ask the council X" with no other framing |
| `review` | Code or change review, security analysis | "review", "audit", "what's wrong with this code", "find bugs in", "security check" |
| `design` | Architecture or technology choice | "design", "should I use X or Y", "what's the best approach for", "architecture for" |
| `plan` | Step-by-step implementation roadmap | "plan", "roadmap", "how would you build", "implementation plan for" |
| `research` | Learn about a topic; explain without recommending | "explain", "how does X work", "what is the state of", "deep dive into" |

Pick the mode from the user's phrasing. When in doubt, use `general`. Pass it via `--mode <mode>` to `init` and `follow-up`. The init output returns `prompts_dir` (e.g. `prompts/review`) — **use that path** for the councillor and chairman prompts in this turn.

## File context — `--files` on init / follow-up

When the question is about specific code (especially in `review` mode), pass the files directly so every councillor sees the same source:

```
node <skill_dir>/bin/council.cjs init --mode review --files src/auth.cjs,src/middleware.cjs --question "Review these for security holes"
```

The helper reads each file, caps it at 50 KB (200 KB total across all `--files`), prepends a `--- FILE: <path> ---` block to the question, and stores the augmented question. The councillors then see the file contents inline. Don't paste files into the question text yourself — let the helper do it so size caps and the file-block framing are consistent.

## The mandatory loop

### Step 0 — Initialise

```
node <skill_dir>/bin/council.cjs init --question "<the user's exact question>" [--mode review|design|plan|research|general] [--files path1,path2,...]
```

Parse JSON output: `url`, `conversation_id`, `turn_id`, `mode`, `prompts_dir`, `council`, `chairman`, `chairman_backend`, `councillor_timeout_seconds`, `min_responses_to_proceed`.

Tell the user once: **"Council convened at \<url\>. Watch live as the deliberation unfolds."**

> If the user said "follow up", use `follow-up --question "..." --cid <previous conversation id>` instead.

### Step 1 — First opinions

**For each councillor in `council`, do one of two things based on its `backend`:**

**Backend = `task`** (parallel, agent-driven):
- Dispatch a `task` sub-agent in **background** mode.
- `model` = the councillor's `id`. `agent_type` = `general-purpose`.
- `prompt` = entire contents of `<skill_dir>/<prompts_dir>/councillor.md` + a blank line + the user's exact question (where `<prompts_dir>` came from init's output, e.g. `prompts/review`).
- Group all `task`-backend councillor dispatches in a single response (parallel tool calls).

**Backend = `github-models`** (synchronous, helper-driven):
- For each one, run (on Windows PowerShell):
  ```powershell
  $prompt = (Get-Content <skill_dir>/<prompts_dir>/councillor.md -Raw) + "`n`n" + $userQuestion
  $resp   = $prompt | node <skill_dir>/bin/council.cjs call --backend github-models --model <councillor.id>
  ```
- On bash / zsh:
  ```bash
  printf '%s\n\n%s' "$(cat <skill_dir>/<prompts_dir>/councillor.md)" "$userQuestion" \
    | node <skill_dir>/bin/council.cjs call --backend github-models --model <councillor.id>
  ```
- The helper prints the response text on stdout (latency metadata on stderr).
- These can be run sequentially (each takes 1-4s).

**As each councillor's response arrives (task or github-models), immediately PATCH the server:**

```powershell
$response | node <skill_dir>/bin/council.cjs patch-councillor `
  --tid <turn_id> --cid <conversation_id> `
  --id <councillor_id> --status ok --latency-ms <elapsed>
```

If a councillor times out, returns garbage, or errors, PATCH with `--status timeout|error|empty` and pipe the error message to stdin.

Once `min_responses_to_proceed` councillors have succeeded, advance:

```
node <skill_dir>/bin/council.cjs advance --tid <turn_id> --cid <conversation_id> --stage 2
```

If fewer than `min_responses_to_proceed` succeed, advance to `--stage -1`, tell the user, and stop.

### Step 2 — Anonymised peer review

Build label map: `Response A` → 1st surviving councillor's id, `Response B` → 2nd, etc.

```
node <skill_dir>/bin/council.cjs set-label-map --tid <turn_id> --cid <conversation_id> --map '{"Response A":"claude-sonnet-4.6", "Response B":"gpt-5.2", ...}'
```

**For each surviving councillor (acting as a ranker), dispatch in its native backend** (same task vs github-models split):

The ranker prompt is `<skill_dir>/prompts/ranker.md` (shared across modes — the anonymised ranking process is the same regardless of question type) with `{{QUESTION}}` and `{{RESPONSES}}` substituted (responses labelled A, B, C, D etc joined by blank lines).

As each ranking returns:

```powershell
$rankingText | node <skill_dir>/bin/council.cjs patch-ranking `
  --tid <turn_id> --cid <conversation_id> `
  --ranker <model_id>
```

(The helper parses `FINAL RANKING:` automatically.)

Once all rankings are in:

```
node <skill_dir>/bin/council.cjs aggregate --tid <turn_id> --cid <conversation_id>
```

### Step 3 — Chairman synthesis

Single dispatch using `chairman` + `chairman_backend` from init's output.

The chairman prompt is `<skill_dir>/<prompts_dir>/chairman.md` (mode-specific, from init's output) with `{{QUESTION}}`, `{{STAGE1}}` (each councillor's response prefixed `Model: <id>\nResponse: <text>\n\n`), and `{{STAGE2}}` (each ranker's raw text prefixed `Model: <id>\nRanking: <raw>\n\n`).

If `chairman_backend == task`, dispatch a `task` sub-agent. If `github-models`, use the `call` helper.

When the chairman returns:

```powershell
$synthesis | node <skill_dir>/bin/council.cjs synthesize `
  --tid <turn_id> --cid <conversation_id> `
  --model <chairman_id>
```

### Step 4 — Respond to the user

After Step 3, tell the user:

> "Synthesis ready at \<url\>. Final answer below."

Then paste the chairman's synthesis as markdown in the chat.

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
| `init --question "..." [--mode general\|review\|design\|plan\|research] [--files a,b,c]` | Start server (if needed), create conversation + turn, return ids + `mode` + `prompts_dir` + council config |
| `follow-up --question "..." --cid <cid> [--mode ...] [--files ...]` | New turn on existing conversation; inherits the conversation's mode unless overridden |
| `doctor [--deep] [--json] [--timeout-ms N]` | Probe every councillor + chairman. github-models backends get a real ping; task backends are listed as `~ skipped` (only the agent can probe those). Prints a table + a JSON sentinel. Run before init when diagnosing missing-councillor issues. |
| `call --backend github-models --model <id> [--max-tokens N] [--timeout-ms N]` (stdin: prompt) | Synchronously call a GitHub Models model. Returns response text on stdout, `{latency_ms, usage}` on stderr |
| `patch-councillor --tid X --cid Y --id <model> --status ok --latency-ms N` (stdin: response) | Push one councillor's response |
| `advance --tid X --cid Y --stage N` | Transition turn to next stage |
| `set-label-map --tid X --cid Y --map '{...}'` | Set anonymisation map |
| `patch-ranking --tid X --cid Y --ranker <model>` (stdin: raw text) | Push one ranking; parser runs automatically |
| `aggregate --tid X --cid Y` | Compute + PATCH aggregate rankings |
| `synthesize --tid X --cid Y --model <chairman>` (stdin: synthesis md) | PATCH stage 3, persists to disk |
| `read-events` | Drain browser-side events file (future use) |
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
