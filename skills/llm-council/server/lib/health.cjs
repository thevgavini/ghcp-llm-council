// Shared HTTP health probe — used by both bin/council.cjs (ensureServer)
// and server/start.cjs to validate that a server-info / server.pid combo
// actually points at a live server before trusting it.
//
// On Windows in particular the OS recycles PIDs aggressively, so a stale
// pid file can match an unrelated process and process.kill(pid, 0) returns
// true. The only reliable check is "does it answer".

const http = require('node:http');

function pingHealth(url, timeoutMs = 800) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (ok) => { if (!resolved) { resolved = true; resolve(ok); } };
    try {
      const u = new URL(`${url}/api/health`);
      const req = http.request({
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        timeout: timeoutMs
      }, (res) => {
        res.resume();
        done(res.statusCode === 200);
      });
      req.on('error', () => done(false));
      req.on('timeout', () => { req.destroy(); done(false); });
      req.end();
    } catch {
      done(false);
    }
  });
}

module.exports = { pingHealth };
