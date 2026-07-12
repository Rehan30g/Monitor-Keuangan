import crypto from 'crypto';
import db from './db.js';
import { generateSecret } from './totp.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 menit
const MAX_CHALLENGE_ATTEMPTS = 5;
const BACKUP_CODE_COUNT = 10;

// Hash cepat sha256 — sama seperti lib/api-tokens.js. Kode cadangan berentropi
// tinggi (bukan password yang bisa ditebak), jadi scrypt tak diperlukan.
function hashBackupCode(rawCode) {
  return crypto.createHash('sha256').update(rawCode.toUpperCase()).digest('hex');
}

// --- mfa_totp (satu baris per user) -------------------------------------

function getMfaTotp(userId) {
  return db.prepare(`SELECT * FROM mfa_totp WHERE userId = ?`).get(userId) || null;
}

function isMfaEnabled(userId) {
  const row = getMfaTotp(userId);
  return Boolean(row && row.enabled);
}

// Enroll ulang: buang secret lama yang belum dikonfirmasi & backup codes lama,
// lalu simpan secret baru dengan enabled=0 (menunggu konfirmasi kode TOTP).
function startEnrollment(userId) {
  const secret = generateSecret();
  const createdAt = Date.now();
  db.prepare(`DELETE FROM mfa_totp WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_backup_codes WHERE userId = ?`).run(userId);
  db.prepare(
    `INSERT INTO mfa_totp (userId, secret, enabled, createdAt) VALUES (?, ?, 0, ?)`
  ).run(userId, secret, createdAt);
  return { secret };
}

function enableMfa(userId) {
  db.prepare(`UPDATE mfa_totp SET enabled = 1 WHERE userId = ?`).run(userId);
}

function disableMfa(userId) {
  db.prepare(`DELETE FROM mfa_totp WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_backup_codes WHERE userId = ?`).run(userId);
}

// --- mfa_backup_codes ---------------------------------------------------

// Format XXXX-XXXX pakai alfabet base32 tanpa karakter membingungkan (0/O, 1/I).
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateBackupCodeRaw() {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += BACKUP_ALPHABET[crypto.randomInt(0, BACKUP_ALPHABET.length)];
    if (i === 3) s += '-';
  }
  return s;
}

// Buang semua kode lama, buat 10 baru. Kembalikan kode MENTAH (hanya ditampilkan
// sekali ini) — DB cuma menyimpan hash-nya.
function regenerateBackupCodes(userId) {
  db.prepare(`DELETE FROM mfa_backup_codes WHERE userId = ?`).run(userId);
  const createdAt = Date.now();
  const insert = db.prepare(
    `INSERT INTO mfa_backup_codes (id, userId, codeHash, createdAt) VALUES (?, ?, ?, ?)`
  );
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = generateBackupCodeRaw();
    codes.push(raw);
    insert.run(crypto.randomUUID(), userId, hashBackupCode(raw), createdAt);
  }
  return codes;
}

// Cari kode cadangan yang belum dipakai & cocok; jika ada, tandai terpakai
// dan kembalikan true. Konsumsi single-use.
function consumeBackupCode(userId, rawCode) {
  const cleaned = String(rawCode || '').toUpperCase().replace(/\s+/g, '');
  if (!cleaned) return false;
  const codeHash = hashBackupCode(cleaned);
  const row = db
    .prepare(
      `SELECT * FROM mfa_backup_codes WHERE userId = ? AND codeHash = ? AND usedAt IS NULL`
    )
    .get(userId, codeHash);
  if (!row) return false;
  const res = db
    .prepare(`UPDATE mfa_backup_codes SET usedAt = ? WHERE id = ? AND usedAt IS NULL`)
    .run(Date.now(), row.id);
  return res.changes > 0;
}

function countUnusedBackupCodes(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM mfa_backup_codes WHERE userId = ? AND usedAt IS NULL`
    )
    .get(userId);
  return row ? row.n : 0;
}

// --- mfa_login_challenges (jembatan "password OK" → "sesi terbit") ------

function createLoginChallenge(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + CHALLENGE_TTL_MS;
  // Batalkan challenge aktif sebelumnya milik user ini (pola defensif sama
  // seperti kode verifikasi/token reset).
  db.prepare(
    `UPDATE mfa_login_challenges SET consumed = 1 WHERE userId = ? AND consumed = 0`
  ).run(userId);
  db.prepare(
    `INSERT INTO mfa_login_challenges (id, userId, createdAt, expiresAt, attempts, consumed) VALUES (?, ?, ?, ?, 0, 0)`
  ).run(id, userId, createdAt, expiresAt);
  return { id, expiresAt };
}

function getLoginChallenge(id) {
  return db.prepare(`SELECT * FROM mfa_login_challenges WHERE id = ?`).get(id) || null;
}

function isChallengeUsable(entry) {
  if (!entry) return false;
  if (entry.consumed) return false;
  if (entry.expiresAt < Date.now()) return false;
  if (entry.attempts >= MAX_CHALLENGE_ATTEMPTS) return false;
  return true;
}

function incrementChallengeAttempts(id) {
  db.prepare(`UPDATE mfa_login_challenges SET attempts = attempts + 1 WHERE id = ?`).run(id);
}

function consumeLoginChallenge(id) {
  db.prepare(`UPDATE mfa_login_challenges SET consumed = 1 WHERE id = ?`).run(id);
}

// Dipanggil dari deleteUserAccount untuk membersihkan seluruh jejak MFA.
function deleteAllMfaForUser(userId) {
  db.prepare(`DELETE FROM mfa_totp WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_backup_codes WHERE userId = ?`).run(userId);
  db.prepare(`DELETE FROM mfa_login_challenges WHERE userId = ?`).run(userId);
}

export {
  getMfaTotp,
  isMfaEnabled,
  startEnrollment,
  enableMfa,
  disableMfa,
  regenerateBackupCodes,
  consumeBackupCode,
  countUnusedBackupCodes,
  createLoginChallenge,
  getLoginChallenge,
  isChallengeUsable,
  incrementChallengeAttempts,
  consumeLoginChallenge,
  deleteAllMfaForUser,
  MAX_CHALLENGE_ATTEMPTS
};
