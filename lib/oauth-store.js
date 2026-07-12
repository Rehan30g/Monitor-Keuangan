import crypto from 'crypto';
import db from './db.js';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 menit — cukup untuk alur redirect interaktif
const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1 jam
const ACCESS_TOKEN_PREFIX = 'uku_oat_';
const REFRESH_TOKEN_PREFIX = 'uku_ort_';

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

// --- Klien OAuth (Dynamic Client Registration, RFC 7591) ---------------

function getOAuthClient(clientId) {
  return db.prepare(`SELECT * FROM oauth_clients WHERE clientId = ?`).get(clientId) || undefined;
}

function registerOAuthClient({ clientId, clientSecret, clientSecretExpiresAt, redirectUris, clientName }) {
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO oauth_clients (clientId, clientSecret, clientSecretExpiresAt, redirectUris, clientName, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(clientId, clientSecret || null, clientSecretExpiresAt || null, JSON.stringify(redirectUris), clientName || null, createdAt);
}

// --- Kode otorisasi sementara (authorization code + PKCE) ---------------

function createAuthorizationCode({ clientId, userId, redirectUri, codeChallenge, scopes, resource }) {
  const code = crypto.randomBytes(32).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + AUTH_CODE_TTL_MS;
  db.prepare(
    `INSERT INTO oauth_auth_codes (code, clientId, userId, redirectUri, codeChallenge, scopes, resource, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(code, clientId, userId, redirectUri, codeChallenge, JSON.stringify(scopes || []), resource || null, createdAt, expiresAt);
  return code;
}

function getAuthorizationCode(code) {
  const row = db.prepare(`SELECT * FROM oauth_auth_codes WHERE code = ?`).get(code);
  if (!row) return null;
  if (row.consumed || row.expiresAt < Date.now()) return null;
  return row;
}

function consumeAuthorizationCode(code) {
  db.prepare(`UPDATE oauth_auth_codes SET consumed = 1 WHERE code = ?`).run(code);
}

// --- Access + refresh token (hasil tukar kode / refresh) ----------------

function issueOAuthTokens({ clientId, userId, scopes, resource }) {
  const accessToken = ACCESS_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const refreshToken = REFRESH_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const createdAt = Date.now();
  const expiresAt = Math.floor(createdAt / 1000) + ACCESS_TOKEN_TTL_SEC;
  db.prepare(
    `INSERT INTO oauth_access_tokens (tokenHash, refreshTokenHash, clientId, userId, scopes, resource, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(hashToken(accessToken), hashToken(refreshToken), clientId, userId, JSON.stringify(scopes || []), resource || null, createdAt, expiresAt);
  return { accessToken, refreshToken, expiresAt, expiresIn: ACCESS_TOKEN_TTL_SEC, scopes: scopes || [] };
}

function findOAuthAccessToken(rawToken) {
  const row = db.prepare(`SELECT * FROM oauth_access_tokens WHERE tokenHash = ?`).get(hashToken(rawToken));
  if (!row || row.revoked) return null;
  return row;
}

function findOAuthTokenByRefresh(rawRefreshToken) {
  const row = db.prepare(`SELECT * FROM oauth_access_tokens WHERE refreshTokenHash = ?`).get(hashToken(rawRefreshToken));
  if (!row || row.revoked) return null;
  return row;
}

function revokeOAuthTokenByRaw(rawToken) {
  const hash = hashToken(rawToken);
  const result = db.prepare(
    `UPDATE oauth_access_tokens SET revoked = 1 WHERE tokenHash = ? OR refreshTokenHash = ?`
  ).run(hash, hash);
  return result.changes > 0;
}

function touchOAuthAccessToken(rawToken) {
  db.prepare(`UPDATE oauth_access_tokens SET lastUsedAt = ? WHERE tokenHash = ?`)
    .run(Date.now(), hashToken(rawToken));
}

// --- Aplikasi terhubung (buat panel "Koneksi" di Pengaturan) ------------

// Satu baris per klien yang punya token aktif (belum di-revoke) milik user
// ini — dipakai/kedaluwarsa boleh, yang penting bukan revoked, supaya
// pengguna tetap lihat koneksi yang tokennya sudah expired tapi belum
// eksplisit diputuskan. connectedSince = token pertama, lastUsedAt = terbaru.
function listConnectedClients(userId) {
  const rows = db.prepare(
    `SELECT
       t.clientId,
       c.clientName,
       MIN(t.createdAt) AS connectedSince,
       MAX(t.lastUsedAt) AS lastUsedAt
     FROM oauth_access_tokens t
     LEFT JOIN oauth_clients c ON c.clientId = t.clientId
     WHERE t.userId = ? AND t.revoked = 0
     GROUP BY t.clientId
     ORDER BY lastUsedAt DESC`
  ).all(userId);
  return rows.map((r) => ({
    clientId: r.clientId,
    clientName: r.clientName || r.clientId,
    connectedSince: r.connectedSince,
    lastUsedAt: r.lastUsedAt || null
  }));
}

// Putuskan (revoke) semua token milik user untuk satu klien tertentu.
function revokeClientForUser(userId, clientId) {
  const result = db.prepare(
    `UPDATE oauth_access_tokens SET revoked = 1 WHERE userId = ? AND clientId = ? AND revoked = 0`
  ).run(userId, clientId);
  return result.changes > 0;
}

export {
  getOAuthClient,
  registerOAuthClient,
  createAuthorizationCode,
  getAuthorizationCode,
  consumeAuthorizationCode,
  issueOAuthTokens,
  findOAuthAccessToken,
  findOAuthTokenByRefresh,
  revokeOAuthTokenByRaw,
  touchOAuthAccessToken,
  listConnectedClients,
  revokeClientForUser
};
