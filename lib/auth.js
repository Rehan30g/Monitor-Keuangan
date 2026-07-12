import crypto from 'crypto';
import db from './db.js';

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 menit
const CODE_TTL_MS = 10 * 60 * 1000; // 10 menit
const MAX_CODE_ATTEMPTS = 5;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const storedBuf = Buffer.from(hashHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

// Dummy hash dipakai untuk menyamakan waktu respons saat username tidak ditemukan,
// supaya penyerang tidak bisa membedakan "user tak ada" dari "password salah" lewat timing.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

function createUser(username, email, password) {
  const id = crypto.randomUUID();
  const passwordHash = hashPassword(password);
  const createdAt = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO users (id, username, email, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run(id, username, email, passwordHash, createdAt);
  return { id, username, email, createdAt };
}

function findUserByUsername(username) {
  const stmt = db.prepare(`SELECT * FROM users WHERE username = ?`);
  return stmt.get(username) || null;
}

function findUserByEmail(email) {
  const stmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
  return stmt.get(email) || null;
}

function findUserById(id) {
  const stmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  return stmt.get(id) || null;
}

function markEmailVerified(userId) {
  const stmt = db.prepare(`UPDATE users SET emailVerified = 1 WHERE id = ?`);
  stmt.run(userId);
}

function updateDisplayName(userId, displayName) {
  const stmt = db.prepare(`UPDATE users SET displayName = ? WHERE id = ?`);
  stmt.run(displayName, userId);
}

function updateAvatarExt(userId, ext) {
  const stmt = db.prepare(`UPDATE users SET avatarExt = ? WHERE id = ?`);
  stmt.run(ext, userId);
}

function updatePassword(userId, newPassword) {
  const passwordHash = hashPassword(newPassword);
  const stmt = db.prepare(`UPDATE users SET passwordHash = ? WHERE id = ?`);
  stmt.run(passwordHash, userId);
}

function registerFailedLogin(user) {
  const failedLoginCount = user.failedLoginCount + 1;
  const lockedUntil =
    failedLoginCount >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCKOUT_MS : null;
  const stmt = db.prepare(
    `UPDATE users SET failedLoginCount = ?, lockedUntil = ? WHERE id = ?`
  );
  stmt.run(failedLoginCount, lockedUntil, user.id);
}

function resetFailedLogins(user) {
  const stmt = db.prepare(
    `UPDATE users SET failedLoginCount = 0, lockedUntil = NULL WHERE id = ?`
  );
  stmt.run(user.id);
}

function isLocked(user) {
  return Boolean(user.lockedUntil) && user.lockedUntil > Date.now();
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;
  const stmt = db.prepare(
    `INSERT INTO sessions (id, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)`
  );
  stmt.run(id, userId, createdAt, expiresAt);
  return { id, expiresAt };
}

function getSession(sessionId) {
  const stmt = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
  const session = stmt.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    destroySession(sessionId);
    return null;
  }
  return session;
}

function destroySession(sessionId) {
  const stmt = db.prepare(`DELETE FROM sessions WHERE id = ?`);
  stmt.run(sessionId);
}

// Hapus akun & seluruh data turunannya. Tabel tanpa FK+cascade (sessions,
// verification_codes) dibersihkan manual; urutan tidak penting karena semua
// difilter by userId, bukan saling mereferensi satu sama lain.
function deleteUserAccount(userId) {
  db.prepare(`DELETE FROM sessions WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM verification_codes WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM transactions WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM telegram_links WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM password_reset_tokens WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM email_change_requests WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM api_tokens WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}

function updateEmail(userId, newEmail) {
  const stmt = db.prepare(`UPDATE users SET email = ? WHERE id = ?`);
  stmt.run(newEmail, userId);
}

// Dipakai setelah ganti/reset password. `exceptSessionId` (opsional) dibiarkan
// hidup supaya user yang baru saja ganti password lewat Pengaturan tidak
// ikut ter-logout dari perangkat yang sedang dipakainya sendiri.
function destroyAllSessionsForUser(userId, exceptSessionId = null) {
  if (exceptSessionId) {
    const stmt = db.prepare(`DELETE FROM sessions WHERE userId = ? AND id != ?`);
    stmt.run(userId, exceptSessionId);
  } else {
    const stmt = db.prepare(`DELETE FROM sessions WHERE userId = ?`);
    stmt.run(userId);
  }
}

function generateCode() {
  // Kode 6 digit, dari rentang aman crypto (bukan Math.random).
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// `id` (token) dikirim ke client untuk mengaitkan permintaan verifikasi berikutnya
// dengan baris kode yang benar, tanpa membocorkan userId. `code` hanya dikirim via email.
function createVerificationCode(userId, purpose) {
  const id = crypto.randomUUID();
  const code = generateCode();
  const createdAt = Date.now();
  const expiresAt = createdAt + CODE_TTL_MS;
  const stmt = db.prepare(
    `INSERT INTO verification_codes (id, userId, code, purpose, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run(id, userId, code, purpose, createdAt, expiresAt);
  return { id, code, expiresAt };
}

function getVerificationCode(token, purpose) {
  const stmt = db.prepare(
    `SELECT * FROM verification_codes WHERE id = ? AND purpose = ?`
  );
  return stmt.get(token, purpose) || null;
}

function incrementCodeAttempts(token) {
  const stmt = db.prepare(
    `UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?`
  );
  stmt.run(token);
}

function consumeVerificationCode(token) {
  const stmt = db.prepare(`UPDATE verification_codes SET consumed = 1 WHERE id = ?`);
  stmt.run(token);
}

function isCodeUsable(entry) {
  if (!entry) return false;
  if (entry.consumed) return false;
  if (entry.expiresAt < Date.now()) return false;
  if (entry.attempts >= MAX_CODE_ATTEMPTS) return false;
  return true;
}

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 menit

function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + RESET_TOKEN_TTL_MS;
  const stmt = db.prepare(
    `INSERT INTO password_reset_tokens (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)`
  );
  stmt.run(token, userId, createdAt, expiresAt);
  return { token, expiresAt };
}

function getPasswordResetToken(token) {
  const stmt = db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ?`);
  return stmt.get(token) || null;
}

function isPasswordResetTokenUsable(entry) {
  if (!entry) return false;
  if (entry.consumed) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

function consumePasswordResetToken(token) {
  const stmt = db.prepare(`UPDATE password_reset_tokens SET consumed = 1 WHERE token = ?`);
  stmt.run(token);
}

// Ganti email: token dikirim ke client (untuk konfirmasi berikutnya), kode
// 6 digit dikirim ke EMAIL BARU (bukti kepemilikan alamat itu) — pola sama
// seperti verifikasi email register, tapi bawa newEmail sekalian.
function createEmailChangeRequest(userId, newEmail) {
  const token = crypto.randomUUID();
  const code = generateCode();
  const createdAt = Date.now();
  const expiresAt = createdAt + CODE_TTL_MS;
  const stmt = db.prepare(
    `INSERT INTO email_change_requests (token, userId, newEmail, code, createdAt, expiresAt) VALUES (?, ?, ?, ?, ?, ?)`
  );
  stmt.run(token, userId, newEmail, code, createdAt, expiresAt);
  return { token, code, expiresAt };
}

function getEmailChangeRequest(token) {
  const stmt = db.prepare(`SELECT * FROM email_change_requests WHERE token = ?`);
  return stmt.get(token) || null;
}

function isEmailChangeRequestUsable(entry) {
  if (!entry) return false;
  if (entry.consumed) return false;
  if (entry.expiresAt < Date.now()) return false;
  if (entry.attempts >= MAX_CODE_ATTEMPTS) return false;
  return true;
}

function incrementEmailChangeAttempts(token) {
  const stmt = db.prepare(`UPDATE email_change_requests SET attempts = attempts + 1 WHERE token = ?`);
  stmt.run(token);
}

function consumeEmailChangeRequest(token) {
  const stmt = db.prepare(`UPDATE email_change_requests SET consumed = 1 WHERE token = ?`);
  stmt.run(token);
}

export {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  registerFailedLogin,
  resetFailedLogins,
  isLocked,
  createSession,
  getSession,
  destroySession,
  destroyAllSessionsForUser,
  deleteUserAccount,
  markEmailVerified,
  updateDisplayName,
  updateAvatarExt,
  updatePassword,
  updateEmail,
  createVerificationCode,
  getVerificationCode,
  incrementCodeAttempts,
  consumeVerificationCode,
  isCodeUsable,
  createPasswordResetToken,
  getPasswordResetToken,
  isPasswordResetTokenUsable,
  consumePasswordResetToken,
  createEmailChangeRequest,
  getEmailChangeRequest,
  isEmailChangeRequestUsable,
  incrementEmailChangeAttempts,
  consumeEmailChangeRequest,
  SESSION_TTL_MS,
  MAX_CODE_ATTEMPTS
};
