const crypto = require('node:crypto');

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function isoNow() {
  return new Date().toISOString();
}

module.exports = { newId, isoNow };
