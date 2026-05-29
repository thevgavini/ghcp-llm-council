#!/usr/bin/env node
// council.cjs — agent-facing helper for the LLM Council skill.
//
// The agent (Copilot CLI in a ghcp session) uses this helper instead of
// composing raw HTTP calls. Every subcommand prints a single JSON line on
// stdout (success or {error: "..."}). Multi-line text payloads (councillor
// responses, ranker outputs, chairman synthesis) are read from stdin to
// avoid shell escaping issues.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');

const SKILL_DIR = path.resolve(__dirname, '..');               // skills/llm-council
const SERVER_START = path.join(SKILL_DIR, 'server', 'start.cjs');
const RANKING_LIB = path.join(SKILL_DIR, 'server', 'lib', 'ranking.cjs');

const GH_MODELS_HOST = 'models.github.ai';
const GH_MODELS_PATH = '/inference/chat/completions';

// ---- arg parsing ----------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function die(msg) { console.log(JSON.stringify({ error: msg })); process.exit(1); }
function ok(data) { console.log(JSON.stringify(data)); process.exit(0); }

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// ---- server discovery -----------------------------------------------------

function sessionDir() { return path.join(process.cwd(), '.llm-council'); }
function stateDir() { return path.join(sessionDir(), 'state'); }
function infoPath() { return path.join(stateDir(), 'server-info'); }
function eventsPath() { return path.join(stateDir(), 'events'); }

function readServerInfo() {
  if (!fs.existsSync(infoPath())) return null;
  try { return JSON.parse(fs.readFileSync(infoPath(), 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function ensureServer(ownerPid) {
  const info = readServerInfo();
  if (info) {
    const pidFile = path.join(stateDir(), 'server.pid');
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      // Belt and braces: the pid being alive is necessary but not sufficient
      // (the OS may have recycled it for an unrelated process). Verify the
      // server actually responds at the URL we have on file.
      if (pidAlive(pid) && await pingHealth(info.url)) return info;
    }
    // Stale: nuke the metadata so start.cjs gets a clean slate.
    try { fs.unlinkSync(infoPath()); } catch {}
    try { fs.unlinkSync(path.join(stateDir(), 'server.pid')); } catch {}
  }
  await new Promise((resolve, reject) => {
    const cargs = ['--dir', sessionDir()];
    if (ownerPid) cargs.push('--owner-pid', String(ownerPid));
    const child = spawn(process.execPath, [SERVER_START, ...cargs], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => stderr += c.toString());
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`start.cjs exited ${code}: ${stderr.trim()}`));
    });
  });
  const info2 = readServerInfo();
  if (!info2) throw new Error('server-info missing after start.cjs success');
  return info2;
}

function pingHealth(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(`${url}/api/health`);
      const req = http.request({
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        timeout: 800
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ---- HTTP -----------------------------------------------------------------

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Accept': 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    // Auto-attach CSRF token for mutating requests so subcommands don't have
    // to thread it through. Reads fresh from server-info each call (cheap).
    if (method !== 'GET' && method !== 'HEAD') {
      const token = getCsrfToken();
      if (token) headers['X-Council-Token'] = token;
    }
    const req = http.request({
      method,
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`${method} ${url} -> ${res.statusCode}: ${text}`));
        try { resolve(text ? JSON.parse(text) : null); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getCsrfToken() {
  const info = readServerInfo();
  return info && info.csrf_token;
}

// ---- subcommands ----------------------------------------------------------

async function cmdInit(args) {
  if (!args.question) die('init requires --question "..."');
  const info = await ensureServer(args['owner-pid']);
  const conv = await api('POST', `${info.url}/api/conversations`, { question: args.question });
  const turn = await api('POST', `${info.url}/api/conversations/${conv.id}/turns`, { question: args.question });
  const config = await api('GET', `${info.url}/api/config`);
  ok({
    url: info.url,
    conversation_id: conv.id,
    turn_id: turn.id,
    council: config.council,
    chairman: config.chairman,
    chairman_backend: config.chairman_backend,
    min_responses_to_proceed: config.min_responses_to_proceed,
    councillor_timeout_seconds: config.councillor_timeout_seconds
  });
}

async function cmdFollowUp(args) {
  if (!args.question) die('follow-up requires --question "..."');
  if (!args.cid) die('follow-up requires --cid (existing conversation id)');
  const info = readServerInfo();
  if (!info) die('no server running; call `init` first');
  const turn = await api('POST', `${info.url}/api/conversations/${args.cid}/turns`, { question: args.question });
  const config = await api('GET', `${info.url}/api/config`);
  ok({
    url: info.url,
    conversation_id: args.cid,
    turn_id: turn.id,
    council: config.council,
    chairman: config.chairman,
    chairman_backend: config.chairman_backend,
    min_responses_to_proceed: config.min_responses_to_proceed,
    councillor_timeout_seconds: config.councillor_timeout_seconds
  });
}

async function cmdPatchCouncillor(args) {
  const info = readServerInfo();
  if (!info) die('no server running; call `init` first');
  if (!args.tid) die('patch-councillor requires --tid');
  if (!args.id) die('patch-councillor requires --id (councillor model id)');
  const cid = args.cid || await inferCid(info.url, args.tid);
  const conv = await api('GET', `${info.url}/api/conversations/${cid}`);
  const turn = conv.turns.find((t) => t.id === args.tid);
  if (!turn) die(`turn ${args.tid} not in conversation ${cid}`);
  const response = await readStdin();
  const status = args.status || 'ok';
  const existing = (turn.councillors || []).filter((c) => c.id !== args.id);
  const entry = { id: args.id, status };
  if (status === 'ok') {
    entry.response = response.trim();
    if (args['latency-ms']) entry.latency_ms = Number(args['latency-ms']);
  } else {
    entry.error = response.trim();
  }
  const councillors = [...existing, entry];
  await api('PATCH', `${info.url}/api/turns/${args.tid}`, { conversation_id: cid, councillors });
  ok({ ok: true, councillor: args.id, status });
}

async function cmdAdvance(args) {
  const info = readServerInfo();
  if (!info) die('no server running');
  if (!args.tid) die('advance requires --tid');
  if (args.stage === undefined) die('advance requires --stage');
  const cid = args.cid || await inferCid(info.url, args.tid);
  await api('PATCH', `${info.url}/api/turns/${args.tid}`, { conversation_id: cid, stage: Number(args.stage) });
  ok({ ok: true, stage: Number(args.stage) });
}

async function cmdSetLabelMap(args) {
  const info = readServerInfo();
  if (!info) die('no server running');
  if (!args.tid) die('set-label-map requires --tid');
  if (!args.map) die('set-label-map requires --map (JSON)');
  let map;
  try { map = JSON.parse(args.map); } catch (e) { die('--map must be JSON'); }
  const cid = args.cid || await inferCid(info.url, args.tid);
  await api('PATCH', `${info.url}/api/turns/${args.tid}`, { conversation_id: cid, label_map: map });
  ok({ ok: true, labels: Object.keys(map) });
}

async function cmdPatchRanking(args) {
  const info = readServerInfo();
  if (!info) die('no server running');
  if (!args.tid) die('patch-ranking requires --tid');
  if (!args.ranker) die('patch-ranking requires --ranker (model id)');
  const cid = args.cid || await inferCid(info.url, args.tid);
  const raw = (await readStdin()).trim();
  let parsed;
  if (args.parsed) {
    try { parsed = JSON.parse(args.parsed); } catch { die('--parsed must be a JSON array'); }
  } else {
    const { parseRanking } = require(RANKING_LIB);
    parsed = parseRanking(raw);
  }
  const conv = await api('GET', `${info.url}/api/conversations/${cid}`);
  const turn = conv.turns.find((t) => t.id === args.tid);
  if (!turn) die(`turn ${args.tid} not found`);
  const existing = (turn.rankings || []).filter((r) => r.ranker !== args.ranker);
  const rankings = [...existing, { ranker: args.ranker, raw, parsed }];
  await api('PATCH', `${info.url}/api/turns/${args.tid}`, { conversation_id: cid, rankings });
  ok({ ok: true, ranker: args.ranker, parsed });
}

async function cmdAggregate(args) {
  const info = readServerInfo();
  if (!info) die('no server running');
  if (!args.tid) die('aggregate requires --tid');
  const cid = args.cid || await inferCid(info.url, args.tid);
  const conv = await api('GET', `${info.url}/api/conversations/${cid}`);
  const turn = conv.turns.find((t) => t.id === args.tid);
  if (!turn) die(`turn ${args.tid} not found`);
  const { aggregate } = require(RANKING_LIB);
  const ballots = (turn.rankings || []).map((r) => r.parsed || []);
  const agg = aggregate(ballots, turn.label_map || {});
  await api('PATCH', `${info.url}/api/turns/${args.tid}`, { conversation_id: cid, aggregate: agg });
  ok({ ok: true, aggregate: agg });
}

async function cmdSynthesize(args) {
  const info = readServerInfo();
  if (!info) die('no server running');
  if (!args.tid) die('synthesize requires --tid');
  if (!args.model) die('synthesize requires --model (chairman id)');
  const cid = args.cid || await inferCid(info.url, args.tid);
  const text = (await readStdin()).trim();
  await api('PATCH', `${info.url}/api/turns/${args.tid}`, {
    conversation_id: cid,
    stage: 3,
    synthesis: { model: args.model, text }
  });
  ok({ ok: true, model: args.model });
}

async function cmdReadEvents() {
  if (!fs.existsSync(eventsPath())) return ok({ events: [] });
  const raw = fs.readFileSync(eventsPath(), 'utf8');
  fs.writeFileSync(eventsPath(), '');
  const events = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  ok({ events });
}

async function cmdStatus() {
  const info = readServerInfo();
  if (!info) return ok({ server: null });
  let conversations = [];
  try { conversations = await api('GET', `${info.url}/api/conversations`); } catch {}
  ok({ server: info, conversations: conversations.length });
}

// ---- Backend dispatch (github-models) -------------------------------------

function ghToken() {
  // 1. Allow override via env var (useful for CI / non-gh setups)
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  // 2. Otherwise call `gh auth token` from the gh CLI
  const candidates = [
    'gh',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'GitHub CLI', 'gh.exe') : null,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'GitHub CLI', 'gh.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe') : null
  ].filter(Boolean);

  let lastErr = null;
  for (const cand of candidates) {
    try {
      const out = execFileSync(cand, ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      if (out) return out;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Could not get a GitHub token. Install GitHub CLI (`winget install GitHub.cli` or https://cli.github.com/) and run `gh auth login`, or set GITHUB_TOKEN env var.');
}

function postChatCompletion(token, model, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      ...(opts.max_tokens ? { max_tokens: opts.max_tokens } : {})
    });
    const req = https.request({
      hostname: GH_MODELS_HOST,
      port: 443,
      path: GH_MODELS_PATH,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
        'User-Agent': 'llm-council/0.1'
      },
      timeout: (opts.timeout_ms || 120000)
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) return reject(new Error(`${res.statusCode}: ${text.slice(0, 500)}`));
        try {
          const j = JSON.parse(text);
          const content = j?.choices?.[0]?.message?.content ?? '';
          resolve({ content, usage: j.usage || null, raw: j });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.write(body);
    req.end();
  });
}

async function cmdCall(args) {
  if (!args.backend) die('call requires --backend');
  if (!args.model) die('call requires --model');
  const prompt = await readStdin();
  if (!prompt.trim()) die('call requires a non-empty prompt on stdin');
  const start = Date.now();

  if (args.backend === 'task') {
    die('backend "task" cannot be invoked from the helper. The agent dispatches task sub-agents directly with the task tool and then calls patch-councillor with the response.');
  }

  if (args.backend === 'github-models') {
    let token;
    try { token = ghToken(); } catch (e) { die(e.message); }
    try {
      const { content, usage } = await postChatCompletion(token, args.model, prompt, {
        max_tokens: args['max-tokens'] ? Number(args['max-tokens']) : undefined,
        timeout_ms: args['timeout-ms'] ? Number(args['timeout-ms']) : undefined
      });
      // Print the response text directly (not JSON-wrapped) so the agent can pipe it.
      // But ALSO emit a metadata line on stderr for the agent to capture latency.
      process.stderr.write(JSON.stringify({ latency_ms: Date.now() - start, usage }) + '\n');
      process.stdout.write(content);
      process.exit(0);
    } catch (e) {
      die(`github-models call failed: ${e.message}`);
    }
  }

  die(`unknown backend: ${args.backend}`);
}

async function inferCid(baseUrl, tid) {
  const list = await api('GET', `${baseUrl}/api/conversations`);
  for (const c of list) {
    const full = await api('GET', `${baseUrl}/api/conversations/${c.id}`);
    if (full.turns.find((t) => t.id === tid)) return c.id;
  }
  die(`could not find conversation containing turn ${tid}; pass --cid explicitly`);
}

// ---- main -----------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.length === 0) {
  die('usage: council.cjs <subcommand> [--flags]  (subcommands: init|follow-up|call|patch-councillor|advance|set-label-map|patch-ranking|aggregate|synthesize|read-events|status)');
}

const sub = argv[0];
const args = parseArgs(argv.slice(1));

const map = {
  'init': cmdInit,
  'follow-up': cmdFollowUp,
  'patch-councillor': cmdPatchCouncillor,
  'advance': cmdAdvance,
  'set-label-map': cmdSetLabelMap,
  'patch-ranking': cmdPatchRanking,
  'aggregate': cmdAggregate,
  'synthesize': cmdSynthesize,
  'read-events': cmdReadEvents,
  'status': cmdStatus,
  'call': cmdCall
};

const fn = map[sub];
if (!fn) die(`unknown subcommand: ${sub}`);
fn(args).catch((e) => die(e.message || String(e)));
