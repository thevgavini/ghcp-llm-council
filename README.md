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
# 1. Clone (anywhere)
git clone https://github.com/USER/ghcp-llm-council.git ~/ghcp-llm-council

# 2. Register as a Copilot CLI plugin (one-time setup)
mkdir -p ~/.copilot/installed-plugins/ghcp-llm-council-marketplace
ln -s ~/ghcp-llm-council ~/.copilot/installed-plugins/ghcp-llm-council-marketplace/ghcp-llm-council

# 3. Add to ~/.copilot/settings.json under extraKnownMarketplaces:
#   "ghcp-llm-council-marketplace": {
#     "source": { "source": "local", "path": "<absolute path to the symlink above>" }
#   }
# And under enabledPlugins:
#   "ghcp-llm-council@ghcp-llm-council-marketplace": true

# 4. Add to ~/.copilot/config.json under installedPlugins:
#   { "name": "ghcp-llm-council", "marketplace": "ghcp-llm-council-marketplace",
#     "version": "0.4.0", "installed_at": "<now>", "enabled": true,
#     "cache_path": "<absolute path to the symlink above>" }

# 5. Restart your Copilot CLI session.
```

On Windows substitute `mklink /J` for `ln -s`.

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
npm test               # run all tests (works on Node 20, 22, and 24)
node --test --watch    # watch mode
node skills/llm-council/server/start.cjs   # launch server standalone for UI dev
node skills/llm-council/server/stop.cjs    # tear down
```

## License

MIT — see [LICENSE](./LICENSE) for full text.

This project bundles two third-party libraries in the frontend, each kept
under its original license. Full license texts and notices live in
[skills/llm-council/server/public/vendor/LICENSES/](skills/llm-council/server/public/vendor/LICENSES/):

- **marked** v12.0.0 — MIT
- **DOMPurify** v3.2.4 — Apache-2.0 OR MPL-2.0 (dual-licensed)
