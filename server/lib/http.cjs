const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

function createHttpServer({ publicDir, stateDir, conversationsDir, defaultsPath }) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(conversationsDir, { recursive: true });
  const ctx = { publicDir, stateDir, conversationsDir, defaultsPath };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === '/api/health') return json(res, 200, { ok: true });
      if (req.url.startsWith('/api/')) return notFound(res); // routes added in Task 8
      const file = req.url === '/' ? '/index.html' : req.url;
      const resolved = path.normalize(path.join(publicDir, file));
      if (!resolved.startsWith(publicDir)) return notFound(res);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return notFound(res);
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(resolved).pipe(res);
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  function listen(port, host) {
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        ctx.port = server.address().port;
        ctx.host = host;
        resolve();
      });
    });
  }
  function close() { return new Promise((r) => server.close(r)); }

  return new Proxy({ listen, close, server, ctx }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'port') return ctx.port;
      if (k === 'host') return ctx.host;
    }
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function notFound(res) { res.writeHead(404); res.end('not found'); }

module.exports = { createHttpServer, json, notFound };
