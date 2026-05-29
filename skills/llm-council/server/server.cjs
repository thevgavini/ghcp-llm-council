const fs = require('node:fs');
const path = require('node:path');
const { createHttpServer } = require('./lib/http.cjs');

const DIR = process.env.LLM_COUNCIL_DIR || path.join(process.cwd(), '.llm-council');
const HOST = process.env.LLM_COUNCIL_HOST || '127.0.0.1';
const URL_HOST = process.env.LLM_COUNCIL_URL_HOST || HOST;
const OWNER_PID = process.env.LLM_COUNCIL_OWNER_PID ? Number(process.env.LLM_COUNCIL_OWNER_PID) : null;
const IDLE_MS = Number(process.env.LLM_COUNCIL_IDLE_MS || 30 * 60 * 1000);
const LIFECYCLE_MS = Number(process.env.LLM_COUNCIL_LIFECYCLE_INTERVAL_MS || 60 * 1000);
const ALLOW_REMOTE = process.env.LLM_COUNCIL_ALLOW_REMOTE === '1';

// M2: refuse to bind a non-loopback host unless explicitly opted in.
// All council content is unauthenticated by REST/WS contract; binding to
// 0.0.0.0 silently exposes everything to the LAN.
const LOOPBACKS = new Set(['127.0.0.1', '::1', 'localhost']);
if (!LOOPBACKS.has(HOST) && !ALLOW_REMOTE) {
  console.error(JSON.stringify({
    type: 'refused-to-start',
    reason: `LLM_COUNCIL_HOST=${HOST} would expose unauthenticated council content beyond this machine. Set LLM_COUNCIL_ALLOW_REMOTE=1 to confirm you understand the risk, or bind to 127.0.0.1.`
  }));
  process.exit(2);
}

const stateDir = path.join(DIR, 'state');
const conversationsDir = path.join(DIR, 'conversations');
const publicDir = path.join(__dirname, 'public');
const defaultsPath = path.join(__dirname, '..', 'defaults', 'council.json');

fs.mkdirSync(stateDir, { recursive: true });

const server = createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath });

let lastActivity = Date.now();
server.onEvent && server.onEvent(() => { lastActivity = Date.now(); });

async function start() {
  await server.listen(0, HOST);
  const info = {
    type: 'server-started',
    port: server.port,
    host: HOST,
    url_host: URL_HOST,
    url: `http://${URL_HOST}:${server.port}`,
    session_dir: DIR,
    state_dir: stateDir,
    csrf_token: server.csrfToken
  };
  fs.writeFileSync(path.join(stateDir, 'server-info'), JSON.stringify(info, null, 2));
  fs.writeFileSync(path.join(stateDir, 'server.pid'), String(process.pid));
  console.log(JSON.stringify(info));
}

function shutdown(reason) {
  const info = path.join(stateDir, 'server-info');
  if (fs.existsSync(info)) fs.unlinkSync(info);
  fs.writeFileSync(path.join(stateDir, 'server-stopped'), JSON.stringify({ reason, timestamp: Date.now() }) + '\n');
  console.log(JSON.stringify({ type: 'server-stopped', reason }));
  server.close().then(() => process.exit(0));
}

function ownerAlive() {
  if (!OWNER_PID) return true;
  try { process.kill(OWNER_PID, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

setInterval(() => {
  if (!ownerAlive()) shutdown('owner process exited');
  else if (Date.now() - lastActivity > IDLE_MS) shutdown('idle timeout');
}, LIFECYCLE_MS).unref();

process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));

start().catch((e) => { console.error(e); process.exit(1); });
