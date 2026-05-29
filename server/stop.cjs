const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') out.dir = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args.dir || path.join(process.cwd(), '.llm-council');
const pidPath = path.join(dir, 'state', 'server.pid');
const infoPath = path.join(dir, 'state', 'server-info');

if (!fs.existsSync(pidPath)) {
  console.log(JSON.stringify({ type: 'noop', reason: 'no pid file' }));
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidPath, 'utf8'));
try {
  process.kill(pid);
  console.log(JSON.stringify({ type: 'stopped', pid }));
  // Clean up files after sending signal (helps on Windows where shutdown might be slow)
  setTimeout(() => {
    try { if (fs.existsSync(infoPath)) fs.unlinkSync(infoPath); } catch {}
    try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch {}
    process.exit(0);
  }, 100);
} catch (e) {
  console.log(JSON.stringify({ type: 'noop', reason: e.code || e.message }));
  process.exit(0);
}
