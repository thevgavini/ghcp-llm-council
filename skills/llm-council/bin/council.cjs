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
const { spawn } = require('node:child_process');

const SKILL_DIR = path.resolve(__dirname, '..');               // skills/llm-council
const SERVER_START = path.join(SKILL_DIR, 'server', 'start.cjs');
const RANKING_LIB = path.join(SKILL_DIR, 'server', 'lib', 'ranking.cjs');

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
      if (pidAlive(pid)) return info;
    }
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
  die('usage: council.cjs <subcommand> [--flags]  (subcommands: init|follow-up|patch-councillor|advance|set-label-map|patch-ranking|aggregate|synthesize|read-events|status)');
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
  'status': cmdStatus
};

const fn = map[sub];
if (!fn) die(`unknown subcommand: ${sub}`);
fn(args).catch((e) => die(e.message || String(e)));
