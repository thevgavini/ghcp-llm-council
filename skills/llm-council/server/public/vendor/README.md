# Vendored frontend dependencies

This directory bundles two third-party JavaScript libraries used by the
browser UI. Both are loaded directly from disk (no CDN, no npm install)
so the skill is self-contained.

## marked.min.js — v12.0.0

- Source: https://github.com/markedjs/marked
- License: MIT — see `LICENSES/marked-MIT.txt` for full text
- Usage: parses councillor / chairman markdown into HTML
- SHA-256 pinned in `CHECKSUMS`; verified by `tests/vendor-checksums.test.js`

## purify.min.js — v3.2.4

- Source: https://github.com/cure53/DOMPurify
- License: Apache-2.0 OR MPL-2.0 (dual-licensed; you may choose either)
- License texts: `LICENSES/Apache-2.0.txt`, `LICENSES/MPL-2.0.txt`
- Copyright: © Cure53 and other contributors. The original notice is
  preserved in the minified file header.
- Usage: sanitises rendered markdown before insertion into the DOM
  (defense-in-depth XSS hardening, see security review v0.1.1)
- SHA-256 pinned in `CHECKSUMS`; verified by `tests/vendor-checksums.test.js`

## Updating

When upgrading either dependency:

1. Replace the minified file with the new version. Preserve the upstream
   license header comment — do not strip it.
2. Recompute the SHA-256 and update `CHECKSUMS` in the same commit.
3. If the license changes upstream, replace the corresponding file in
   `LICENSES/` and update this README and the project root `LICENSE`.
