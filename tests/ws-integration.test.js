const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHttpServer } = require('../skills/llm-council/server/lib/http.cjs');
const { decodeFrame, encodeFrame, OPCODES } = require('../skills/llm-council/server/lib/ws.cjs');

let server, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  server = createHttpServer({
    publicDir: path.join(__dirname, '../skills/llm-council/server/public'),
    stateDir: path.join(tmp, 'state'),
    conversationsDir: path.join(tmp, 'conversations'),
    defaultsPath: path.join(__dirname, '../skills/llm-council/defaults/council.json')
  });
  await server.listen(0, '127.0.0.1');
});
after(async () => { await server.close(); });

function wsHandshake(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const sep = buf.indexOf('\r\n\r\n');
        if (sep !== -1 && buf.slice(0, sep).includes('101')) {
          const remainder = buf.slice(sep + 4);
          resolve({ socket, remainder });
        }
      });
      socket.on('error', reject);
    });
  });
}

test('WS handshake succeeds and PATCH broadcasts turn-update', async () => {
  const { socket } = await wsHandshake(server.port);
  const received = [];
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      // server frames are unmasked, decode manually
      if (buf.length < 2) break;
      const len = buf[1] & 0x7F;
      let payloadStart = 2;
      let payloadLen = len;
      if (len === 126) { payloadLen = buf.readUInt16BE(2); payloadStart = 4; }
      else if (len === 127) { payloadLen = Number(buf.readBigUInt64BE(2)); payloadStart = 10; }
      if (buf.length < payloadStart + payloadLen) break;
      received.push(buf.slice(payloadStart, payloadStart + payloadLen).toString());
      buf = buf.slice(payloadStart + payloadLen);
    }
  });

  const c = await (await fetch(`http://127.0.0.1:${server.port}/api/conversations`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question:'q' })})).json();
  const t = await (await fetch(`http://127.0.0.1:${server.port}/api/conversations/${c.id}/turns`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ question:'q' })})).json();
  await fetch(`http://127.0.0.1:${server.port}/api/turns/${t.id}`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ conversation_id: c.id, stage: 1 })});

  await new Promise((r) => setTimeout(r, 100));
  socket.end();
  const messages = received.map((m) => JSON.parse(m));
  const turnUpdates = messages.filter((m) => m.type === 'turn-update');
  assert.ok(turnUpdates.length >= 2, `expected ≥2 turn-update messages, got ${JSON.stringify(messages)}`);
});
