const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pingHealth } = require('./lib/health.cjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
    else if (argv[i] === '--host') out.host = argv[++i];
    else if (argv[i] === '--owner-pid') out.ownerPid = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || path.join(process.cwd(), '.llm-council');
const host = args.host || '127.0.0.1';
const stateDir = path.join(dir, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const infoPath = path.join(stateDir, 'server-info');
const pidPath = path.join(stateDir, 'server.pid');

async function reuseIfHealthy() {
  if (!fs.existsSync(pidPath) || !fs.existsSync(infoPath)) return false;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    process.kill(pid, 0);  // throws if dead
  } catch {
    // Stale metadata. Nuke it so the next reader doesn't get misled either.
    try { fs.unlinkSync(infoPath); } catch {}
    try { fs.unlinkSync(pidPath);  } catch {}
    return false;
  }
  // PID being alive is necessary but not sufficient on Windows where the OS
  // recycles PIDs. Confirm with an actual HTTP ping.
  if (await pingHealth(info.url)) {
    console.log(JSON.stringify(info));
    return true;
  }
  try { fs.unlinkSync(infoPath); } catch {}
  try { fs.unlinkSync(pidPath);  } catch {}
  return false;
}

async function main() {
  if (await reuseIfHealthy()) { process.exit(0); }

  const env = { ...process.env, LLM_COUNCIL_DIR: dir, LLM_COUNCIL_HOST: host };
  if (args.ownerPid) env.LLM_COUNCIL_OWNER_PID = String(args.ownerPid);

  const logFile = fs.openSync(path.join(stateDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
    env, detached: true, stdio: ['ignore', logFile, logFile]
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(infoPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      console.log(JSON.stringify(info));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.error('Server did not start within 5 seconds');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

