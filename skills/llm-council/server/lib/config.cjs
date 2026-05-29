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
