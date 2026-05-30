# Contributing to LLM Council

Thanks for your interest in contributing! Here's how to get involved.

## Getting started

1. Fork and clone the repo
2. Run `node bin/install.js` to install the skill locally
3. Make your changes in `skills/llm-council/`
4. Test by launching a Copilot CLI session and running a council deliberation

## Development

```bash
# Start the server standalone (for UI development)
node skills/llm-council/server/start.cjs

# Stop the server
node skills/llm-council/server/stop.cjs
```

## Pull requests

- Create a feature branch from `main`
- Keep commits focused and atomic
- Update the README if you're adding user-facing features
- Ensure the CI workflow passes

## What to contribute

- **New modes** — add a folder under `skills/llm-council/prompts/` with `councillor.md` and `chairman.md`
- **UI improvements** — the frontend is vanilla JS in `skills/llm-council/server/public/`
- **New model support** — add entries to `defaults/council.json`
- **Bug fixes** — always welcome
- **Documentation** — typos, better examples, screenshots

## Code style

- CommonJS (`.cjs`) for Node scripts — zero external dependencies in the skill itself
- Vanilla JS for the browser UI — no build step
- Keep it simple: no frameworks, no transpilation

## Reporting issues

Use the GitHub issue templates. Include:
- Steps to reproduce
- Expected vs actual behaviour
- Your Node version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
