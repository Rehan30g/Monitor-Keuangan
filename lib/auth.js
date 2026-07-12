import crypto from 'crypto';
import db from './db.js';
import { recordEmailHistory, recordPasswordChange } from './admin.js';
import { removeAvatar } from './avatars.js';

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
  // Fail-closed untuk akun tanpa password (mis. akun Google, passwordHash NULL)
  // atau nilai tersimpan yang rusak — jangan pernah throw, cukup tolak.
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
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

function findUserByGoogleId(googleId) {
  const stmt = db.prepare(`SELECT * FROM users WHERE google_id = ?`);
  return stmt.get(googleId) || null;
}

// Tautkan akun yang sudah ada ke sebuah akun Google (menyimpan 'sub' Google).
function linkGoogleAccount(userId, googleId) {
  db.prepare(`UPDATE users SET google_id = ? WHERE id = ?`).run(googleId, userId);
}

// Turunkan username unik dari local-part email, mengikuti batasan validateUsername
// (3-32 char, hanya [a-zA-Z0-9_]). Tambah sufiks angka bila sudah dipakai.
function generateUniqueUsername(email) {
  let base = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '');
  base = base.slice(0, 32);
  if (base.length < 3) base = `user${crypto.randomInt(1000, 10000)}`;
  let candidate = base;
  let i = 0;
  while (findUserByUsername(candidate)) {
    i += 1;
    if (i > 9999) {
      candidate = `user${crypto.randomBytes(4).toString('hex')}`;
      break;
    }
    const suffix = String(i);
    candidate = `${base.slice(0, 32 - suffix.length)}${suffix}`;
  }
  return candidate;
}

// Buat akun baru dari profil Google: TANPA password (passwordHash NULL), email
// langsung ditandai terverifikasi (Google sudah memverifikasinya), google_id di-set.
function createGoogleUser({ email, googleId, displayName }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const username = generateUniqueUsername(email);
  db.prepare(
    `INSERT INTO users (id, username, email, passwordHash, createdAt, emailVerified, google_id)
     VALUES (?, ?, ?, NULL, ?, 1, ?)`
  ).run(id, username, email, createdAt, googleId);
  if (displayName) {
    const trimmed = String(displayName).trim().slice(0, 40);
    if (trimmed) db.prepare(`UPDATE users SET displayName = ? WHERE id = ?`).run(trimmed, id);
  }
  return findUserById(id);
}

// Buat akun Google dengan username yang DIPILIH user (bukan auto-generate).
// Sama seperti createGoogleUser tapi username diberikan sebagai parameter —
// dipakai setelah user melewati halaman pemilihan username (/google-username).
function createGoogleUserWithUsername({ email, googleId, displayName, username }) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, email, passwordHash, createdAt, emailVerified, google_id)
     VALUES (?, ?, ?, NULL, ?, 1, ?)`
  ).run(id, username, email, createdAt, googleId);
  if (displayName) {
    const trimmed = String(displayName).trim().slice(0, 40);
    if (trimmed) db.prepare(`UPDATE users SET displayName = ? WHERE id = ?`).run(trimmed, id);
  }
  return findUserById(id);
}

// Ganti username + catat waktu perubahan (untuk cooldown 7 hari). Dilakukan
// dalam satu statement UPDATE agar kedua kolom selalu konsisten.
function updateUsername(userId, newUsername) {
  db.prepare(`UPDATE users SET username = ?, usernameChangedAt = ? WHERE id = ?`)
    .run(newUsername, Date.now(), userId);
}

function findUserById(id) {
  const stmt = db.prepare(`SELECT * FROM users WHERE id = ?`);
  return stmt.get(id) || null;
}

const PENDING_GOOGLE_SIGNUP_TTL_MS = 15 * 60 * 1000; // 15 menit

// Simpan profil Google terverifikasi yang belum jadi akun (menunggu user
// memilih username). Token opaque single-use, ber-TTL. Mengembalikan token.
function createPendingGoogleSignup({ email, googleId, displayName, picture }) {
  const token = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + PENDING_GOOGLE_SIGNUP_TTL_MS;
  db.prepare(
    `INSERT INTO pending_google_signups (token, email, googleId, displayName, picture, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(token, email, googleId, displayName || null, picture || null, createdAt, expiresAt);
  return { token, expiresAt };
}

// Ambil pending signup yang masih valid. Lazy-delete bila sudah kedaluwarsa
// (kembalikan null). Baris yang tak ada juga → null.
function getPendingGoogleSignup(token) {
  const row = db.prepare(`SELECT * FROM pending_google_signups WHERE token = ?`).get(token);
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.prepare(`DELETE FROM pending_google_signups WHERE token = ?`).run(token);
    return null;
  }
  return row;
}

// Konsumsi (hapus) pending signup setelah akun benar-benar dibuat. Single-use.
function consumePendingGoogleSignup(token) {
  db.prepare(`DELETE FROM pending_google_signups WHERE token = ?`).run(token);
}

// Sweep pending signups yang sudah lewat TTL. Mengembalikan jumlah yang dihapus.
function purgeExpiredPendingGoogleSignups() {
  const info = db
    .prepare(`DELETE FROM pending_google_signups WHERE expiresAt < ?`)
    .run(Date.now());
  return Number(info.changes) || 0;
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

// `via`: 'self' (ganti dari Pengaturan) | 'reset' (lupa password) |
// 'admin_reset' (dipicu admin). Dicatat ke password_change_log — hanya
// timestamp & sumber, tanpa material password.
function updatePassword(userId, newPassword, via = 'self') {
  const passwordHash = hashPassword(newPassword);
  const stmt = db.prepare(`UPDATE users SET passwordHash = ? WHERE id = ?`);
  stmt.run(passwordHash, userId);
  recordPasswordChange(userId, via);
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

// Soft-delete: tandai akun terhapus (deletedAt) & paksa logout di semua sesi.
// TIDAK menyentuh transaksi, avatar, atau data turunan lain — semuanya harus
// bisa dipulihkan penuh selama masa tenggang 7 hari (lihat purgeExpiredAccounts).
function deleteUserAccount(userId) {
  db.prepare(`UPDATE users SET deletedAt = ? WHERE id = ?`).run(Date.now(), userId);
  destroyAllSessionsForUser(userId);
}

// Pembersihan final permanen — hanya dipanggil oleh sweep 7-hari
// (purgeExpiredAccounts). Menghapus akun & SELURUH data turunannya, termasuk
// file avatar. Tabel tanpa FK+cascade (sessions, verification_codes)
// dibersihkan manual; urutan tidak penting karena semua difilter by userId,
// bukan saling mereferensi satu sama lain.
function purgeUserAccount(userId) {
  removeAvatar(userId);
  db.prepare(`DELETE FROM sessions WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM verification_codes WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM transactions WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM telegram_links WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM password_reset_tokens WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM email_change_requests WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM api_tokens WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_totp WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_backup_codes WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_login_challenges WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM email_history WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM password_change_log WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM login_history WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM admin_actions WHERE targetUserId = ?`).run(userId);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
}

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari masa pemulihan

// Sapu akun soft-deleted yang sudah melewati masa tenggang 7 hari & purge
// permanen. Mengembalikan jumlah akun yang di-purge (untuk logging).
function purgeExpiredAccounts() {
  const cutoff = Date.now() - GRACE_PERIOD_MS;
  const rows = db
    .prepare(`SELECT id FROM users WHERE deletedAt IS NOT NULL AND deletedAt < ?`)
    .all(cutoff);
  for (const row of rows) {
    purgeUserAccount(row.id);
  }
  return rows.length;
}

function updateEmail(userId, newEmail) {
  // Simpan email lama ke email_history sebelum ditimpa.
  const current = db.prepare(`SELECT email FROM users WHERE id = ?`).get(userId);
  if (current && current.email) {
    recordEmailHistory(userId, current.email);
  }
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
  // Batalkan semua kode aktif sebelumnya untuk (userId, purpose) yang sama,
  // supaya hanya kode terbaru yang bisa dipakai. Scoped by purpose agar kode
  // dengan tujuan berbeda milik user yang sama tidak ikut dibatalkan.
  db.prepare(
    `UPDATE verification_codes SET consumed = 1 WHERE userId = ? AND purpose = ? AND consumed = 0`
  ).run(userId, purpose);
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
  // Batalkan semua token reset aktif sebelumnya milik user ini, supaya hanya
  // token terbaru yang bisa dipakai (token lama di inbox jadi tak berlaku).
  db.prepare(
    `UPDATE password_reset_tokens SET consumed = 1 WHERE userId = ? AND consumed = 0`
  ).run(userId);
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
  findUserByGoogleId,
  linkGoogleAccount,
  createGoogleUser,
  createGoogleUserWithUsername,
  updateUsername,
  createPendingGoogleSignup,
  getPendingGoogleSignup,
  consumePendingGoogleSignup,
  purgeExpiredPendingGoogleSignups,
  generateUniqueUsername,
  registerFailedLogin,
  resetFailedLogins,
  isLocked,
  createSession,
  getSession,
  destroySession,
  destroyAllSessionsForUser,
  deleteUserAccount,
  purgeUserAccount,
  purgeExpiredAccounts,
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
