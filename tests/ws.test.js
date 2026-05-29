const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeAcceptKey, encodeFrame, decodeFrame, OPCODES } = require('../server/lib/ws.cjs');

test('computeAcceptKey matches RFC 6455 example', () => {
  // Sec-WebSocket-Key from RFC 6455 §1.3
  assert.equal(computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeFrame produces a valid small text frame', () => {
  const buf = encodeFrame(OPCODES.TEXT, Buffer.from('hi'));
  assert.equal(buf[0], 0x81);
  assert.equal(buf[1], 0x02);
  assert.equal(buf.slice(2).toString(), 'hi');
});

test('encodeFrame uses extended 16-bit length for payloads >=126', () => {
  const payload = Buffer.alloc(200, 'x');
  const buf = encodeFrame(OPCODES.TEXT, payload);
  assert.equal(buf[1], 126);
  assert.equal(buf.readUInt16BE(2), 200);
});

test('encodeFrame uses 64-bit length for payloads >=65536', () => {
  const payload = Buffer.alloc(70000, 'x');
  const buf = encodeFrame(OPCODES.TEXT, payload);
  assert.equal(buf[1], 127);
  assert.equal(Number(buf.readBigUInt64BE(2)), 70000);
});

test('decodeFrame round-trips a masked client text frame', () => {
  const payload = Buffer.from('hello');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
  const frame = Buffer.concat([
    Buffer.from([0x81, 0x80 | masked.length]),
    mask,
    masked
  ]);
  const result = decodeFrame(frame);
  assert.equal(result.opcode, OPCODES.TEXT);
  assert.equal(result.payload.toString(), 'hello');
});

test('decodeFrame returns null when buffer is incomplete', () => {
  assert.equal(decodeFrame(Buffer.from([0x81])), null);
});

test('decodeFrame throws on unmasked client frames', () => {
  assert.throws(() => decodeFrame(Buffer.from([0x81, 0x02, 0x68, 0x69])), /masked/);
});
