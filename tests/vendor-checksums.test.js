// Verifies vendored frontend libraries match the committed SHA-256 checksums.
// If you upgrade a vendor file, regenerate vendor/CHECKSUMS in the same commit.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const VENDOR_DIR = path.join(__dirname, '..', 'skills', 'llm-council', 'server', 'public', 'vendor');

test('vendor/CHECKSUMS matches actual file hashes', () => {
  const lines = fs.readFileSync(path.join(VENDOR_DIR, 'CHECKSUMS'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.length > 0, 'CHECKSUMS should list at least one entry');
  for (const line of lines) {
    const [expected, name] = line.split(/\s+/);
    assert.match(expected, /^[0-9A-Fa-f]{64}$/, `bad hash format: "${line}"`);
    const buf = fs.readFileSync(path.join(VENDOR_DIR, name));
    const actual = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
    assert.equal(actual, expected.toUpperCase(), `checksum mismatch for ${name}`);
  }
});
