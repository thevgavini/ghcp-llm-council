const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
if (fs.existsSync(pidPath)) {
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    process.kill(pid, 0);
    if (fs.existsSync(infoPath)) {
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      console.log(JSON.stringify(info));
      process.exit(0);
    }
  } catch {}
}

const env = { ...process.env, LLM_COUNCIL_DIR: dir, LLM_COUNCIL_HOST: host };
if (args.ownerPid) env.LLM_COUNCIL_OWNER_PID = String(args.ownerPid);

const logFile = fs.openSync(path.join(stateDir, 'server.log'), 'a');
const child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
  env, detached: true, stdio: ['ignore', logFile, logFile]
});
child.unref();

const deadline = Date.now() + 5000;
(function waitForInfo() {
  if (fs.existsSync(infoPath)) {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    console.log(JSON.stringify(info));
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.error('Server did not start within 5 seconds');
    process.exit(1);
  }
  setTimeout(waitForInfo, 100);
})();
