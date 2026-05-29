const fs = require('node:fs');

const VALID_BACKENDS = new Set(['task', 'github-models']);
const VALID_MODES = new Set(['general', 'review', 'design', 'plan', 'research']);

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
    if (c.backend !== undefined && !VALID_BACKENDS.has(c.backend)) {
      return { ok: false, error: `councillor ${c.id}: backend must be one of ${[...VALID_BACKENDS].join(', ')}` };
    }
  }
  if (typeof cfg.chairman !== 'string' || !cfg.chairman) {
    return { ok: false, error: 'chairman must be a non-empty string' };
  }
  if (cfg.chairman_backend !== undefined && !VALID_BACKENDS.has(cfg.chairman_backend)) {
    return { ok: false, error: `chairman_backend must be one of ${[...VALID_BACKENDS].join(', ')}` };
  }
  const min = cfg.min_responses_to_proceed;
  if (!Number.isInteger(min) || min < 1 || min > cfg.council.length) {
    return { ok: false, error: 'min_responses_to_proceed must be a positive integer ≤ council size' };
  }
  const to = cfg.councillor_timeout_seconds;
  if (!Number.isFinite(to) || to <= 0) {
    return { ok: false, error: 'councillor_timeout_seconds must be positive' };
  }
  // Optional mode_packs — each key must be a known mode, each pack is a
  // partial override of {council?, chairman?, chairman_backend?}.
  if (cfg.mode_packs !== undefined) {
    if (typeof cfg.mode_packs !== 'object' || cfg.mode_packs === null) {
      return { ok: false, error: 'mode_packs must be an object' };
    }
    for (const [mode, pack] of Object.entries(cfg.mode_packs)) {
      if (!VALID_MODES.has(mode)) {
        return { ok: false, error: `mode_packs.${mode}: unknown mode (valid: ${[...VALID_MODES].join(', ')})` };
      }
      if (!pack || typeof pack !== 'object') {
        return { ok: false, error: `mode_packs.${mode}: must be an object` };
      }
      if (pack.council !== undefined && !Array.isArray(pack.council)) {
        return { ok: false, error: `mode_packs.${mode}.council: must be an array if present` };
      }
      if (pack.chairman_backend !== undefined && !VALID_BACKENDS.has(pack.chairman_backend)) {
        return { ok: false, error: `mode_packs.${mode}.chairman_backend: invalid` };
      }
    }
  }
  return { ok: true };
}

function normaliseConfig(cfg) {
  const council = cfg.council.map((c) => ({ ...c, backend: c.backend || 'task' }));
  return { ...cfg, council, chairman_backend: cfg.chairman_backend || 'task' };
}

// Overlay a mode pack on top of a base config. Missing pack fields fall
// through to the base. After overlay we re-run validation so a bad pack
// can't ship a broken council (e.g. zero members, duplicate ids).
function resolveModePack(baseCfg, mode) {
  if (!mode || mode === 'general') return baseCfg;
  const pack = baseCfg.mode_packs && baseCfg.mode_packs[mode];
  if (!pack) return baseCfg;
  const merged = normaliseConfig({
    ...baseCfg,
    council: pack.council ? pack.council : baseCfg.council,
    chairman: pack.chairman || baseCfg.chairman,
    chairman_backend: pack.chairman_backend || baseCfg.chairman_backend
  });
  const v = validateConfig(merged);
  if (!v.ok) {
    // Refuse to use a broken pack; return base with a warning so the agent
    // can still operate.
    return { ...baseCfg, warning: `mode_packs.${mode} invalid: ${v.error}; using default council` };
  }
  // Strip mode_packs from the output so we don't re-overlay accidentally.
  const { mode_packs, ...rest } = merged;
  return { ...rest, resolved_mode: mode };
}

function loadConfig({ runtimePath, defaultsPath, mode }) {
  let base, source, warning;
  if (fs.existsSync(runtimePath)) {
    try {
      const raw = fs.readFileSync(runtimePath, 'utf8');
      const parsed = JSON.parse(raw);
      const v = validateConfig(parsed);
      if (v.ok) {
        base = normaliseConfig(parsed); source = 'runtime';
      } else {
        base = normaliseConfig(JSON.parse(fs.readFileSync(defaultsPath, 'utf8')));
        source = 'defaults'; warning = `runtime config invalid: ${v.error}`;
      }
    } catch (e) {
      base = normaliseConfig(JSON.parse(fs.readFileSync(defaultsPath, 'utf8')));
      source = 'defaults'; warning = `runtime config malformed: ${e.message}`;
    }
  } else {
    base = normaliseConfig(JSON.parse(fs.readFileSync(defaultsPath, 'utf8'))); source = 'defaults';
  }
  const resolved = resolveModePack(base, mode);
  return { ...resolved, source, ...(warning ? { warning } : {}) };
}

module.exports = { validateConfig, loadConfig, normaliseConfig, resolveModePack, VALID_BACKENDS, VALID_MODES };
