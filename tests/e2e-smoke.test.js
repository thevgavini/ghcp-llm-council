const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function readJsonLine(stream) {
  return new Promise((resolve) => {
    let buf = '';
    stream.on('data', (c) => {
      buf += c.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
}

test('orchestrator can drive a full 3-stage turn end-to-end', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const server = spawn(process.execPath, [path.join(__dirname, '../server/server.cjs')], {
    env: { ...process.env, LLM_COUNCIL_DIR: tmp, LLM_COUNCIL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    const info = await readJsonLine(server.stdout);
    const base = info.url;
    async function api(m, p, b) {
      const r = await fetch(base + p, { method: m, headers: b ? { 'Content-Type':'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text();
      return t ? JSON.parse(t) : null;
    }

    const cfg = await api('GET', '/api/config');
    assert.ok(cfg.council.length >= 2);

    const { id: cid } = await api('POST', '/api/conversations', { question: 'q?' });
    const { id: tid } = await api('POST', `/api/conversations/${cid}/turns`, { question: 'q?' });

    // Stage 1: simulate 4 councillors completing
    const councillors = cfg.council.map((c, i) => ({ id: c.id, status: 'ok', response: `Answer from ${c.id}`, latency_ms: 1000 + i * 100 }));
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, councillors });
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, stage: 2 });

    // Stage 2: label map + rankings
    const label_map = {}; cfg.council.forEach((c, i) => { label_map[`Response ${String.fromCharCode(65 + i)}`] = c.id; });
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, label_map });
    const rankings = cfg.council.map((c) => ({
      ranker: c.id,
      raw: `Some evaluation.\n\nFINAL RANKING:\n1. Response A\n2. Response B\n3. Response C\n4. Response D`,
      parsed: ['Response A', 'Response B', 'Response C', 'Response D']
    }));
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, rankings });
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, aggregate: [{ model: cfg.council[0].id, avg: 1, votes: 4 }] });

    // Stage 3: synthesis
    await api('PATCH', `/api/turns/${tid}`, { conversation_id: cid, stage: 3, synthesis: { model: cfg.chairman, text: 'Final answer.' } });

    // Verify on disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'conversations', `${cid}.json`), 'utf8'));
    assert.equal(onDisk.turns[0].synthesis.text, 'Final answer.');
    assert.equal(onDisk.turns[0].rankings.length, cfg.council.length);
    assert.equal(onDisk.turns[0].councillors.length, cfg.council.length);

    // Listing surfaces it
    const list = await api('GET', '/api/conversations');
    assert.ok(list.find((c) => c.id === cid));
  } finally {
    server.kill();
  }
});
