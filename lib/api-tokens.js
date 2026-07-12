import crypto from 'crypto';
import db from './db.js';

const TOKEN_PREFIX = 'uku_live_';

// Token acak berentropi tinggi — beda dengan password, tidak perlu scrypt
// (lambat by design untuk password pendek yang bisa ditebak manusia). Untuk
// token 256-bit acak, hash cepat (sha256) sudah lebih dari cukup dan lazim
// dipakai API provider (GitHub, Stripe, dst).
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function createApiToken(userId, label) {
  const id = crypto.randomUUID();
  const rawToken = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  const createdAt = Date.now();

  const stmt = db.prepare(
    `INSERT INTO api_tokens (id, userId, label, tokenHash, createdAt) VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run(id, userId, label, tokenHash, createdAt);

  // rawToken hanya ada di memori sekarang — tidak pernah disimpan, cuma hash-nya.
  return { id, label, createdAt, token: rawToken };
}

function listApiTokens(userId) {
  const stmt = db.prepare(
    `SELECT id, label, createdAt, lastUsedAt FROM api_tokens WHERE userId = ? ORDER BY createdAt DESC`
  );
  return stmt.all(userId);
}

function findApiTokenByRaw(rawToken) {
  const tokenHash = hashToken(rawToken);
  const stmt = db.prepare(`SELECT * FROM api_tokens WHERE tokenHash = ?`);
  return stmt.get(tokenHash) || null;
}

function touchApiToken(id) {
  const stmt = db.prepare(`UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?`);
  stmt.run(Date.now(), id);
}

// userId dicek juga (bukan cuma id) supaya user A tidak bisa mencabut token user B.
function revokeApiToken(userId, id) {
  const stmt = db.prepare(`DELETE FROM api_tokens WHERE id = ? AND userId = ?`);
  const result = stmt.run(id, userId);
  return result.changes > 0;
}

function deleteAllApiTokensForUser(userId) {
  db.prepare(`DELETE FROM api_tokens WHERE userId = ?`).run(userId);
}

export {
  createApiToken,
  listApiTokens,
  findApiTokenByRaw,
  touchApiToken,
  revokeApiToken,
  deleteAllApiTokensForUser
};
