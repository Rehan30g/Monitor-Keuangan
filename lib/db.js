// Muat .env sebelum apa pun membaca process.env (mis. ADMIN_USERNAMES di bawah).
// Idempoten untuk di-import dua kali — server.js/mcp/server.js sudah memuatnya
// lebih dulu, ini cuma jaring pengaman kalau db.js di-import mandiri di skrip.
import './env.js';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// WAL: server web (server.js) dan bot Telegram (bot/bot.js) adalah dua proses Node
// terpisah yang membuka file SQLite yang sama secara bersamaan.
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    failedLoginCount INTEGER NOT NULL DEFAULT 0,
    lockedUntil INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verification_codes (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT NOT NULL,
    jenis TEXT NOT NULL,
    keterangan TEXT NOT NULL,
    jumlah INTEGER NOT NULL,
    waktu TEXT NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS telegram_links (
    chatId TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    linkedAt INTEGER NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS telegram_link_tokens (
    token TEXT PRIMARY KEY,
    chatId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );

  -- Pendaftaran Google yang tertunda: profil terverifikasi Google (email, sub,
  -- nama) yang belum jadi akun karena user harus memilih username dulu. Keyed
  -- oleh token opaque, single-use, ber-TTL (dibersihkan lazy saat lookup +
  -- sweep berkala). Belum ada userId karena akun belum dibuat.
  CREATE TABLE IF NOT EXISTS pending_google_signups (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    googleId TEXT NOT NULL,
    displayName TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_change_requests (
    token TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    newEmail TEXT NOT NULL,
    code TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    label TEXT NOT NULL,
    tokenHash TEXT NOT NULL UNIQUE,
    createdAt INTEGER NOT NULL,
    lastUsedAt INTEGER,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mfa_totp (
    userId TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mfa_backup_codes (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    codeHash TEXT NOT NULL,
    usedAt INTEGER,
    createdAt INTEGER NOT NULL,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS mfa_login_challenges (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    consumed INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS oauth_clients (
    clientId TEXT PRIMARY KEY,
    clientSecret TEXT,
    clientSecretExpiresAt INTEGER,
    redirectUris TEXT NOT NULL,
    clientName TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code TEXT PRIMARY KEY,
    clientId TEXT NOT NULL,
    userId TEXT NOT NULL,
    redirectUri TEXT NOT NULL,
    codeChallenge TEXT NOT NULL,
    scopes TEXT,
    resource TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    tokenHash TEXT PRIMARY KEY,
    refreshTokenHash TEXT UNIQUE,
    clientId TEXT NOT NULL,
    userId TEXT NOT NULL,
    scopes TEXT,
    resource TEXT,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );

  -- Riwayat perubahan email: satu baris per pergantian, menyimpan email LAMA
  -- (yang akan/telah ditimpa). Tidak ada material rahasia.
  CREATE TABLE IF NOT EXISTS email_history (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    oldEmail TEXT NOT NULL,
    changedAt INTEGER NOT NULL
  );

  -- Log perubahan password: HANYA timestamp + sumber ('self' | 'reset'
  -- | 'admin_reset'). Tidak pernah menyimpan password/hash apa pun.
  CREATE TABLE IF NOT EXISTS password_change_log (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    changedAt INTEGER NOT NULL,
    changedVia TEXT NOT NULL
  );

  -- Riwayat percobaan login (sukses & gagal), untuk panel admin.
  CREATE TABLE IF NOT EXISTS login_history (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    occurredAt INTEGER NOT NULL,
    ip TEXT,
    userAgent TEXT,
    success INTEGER NOT NULL
  );

  -- Jejak audit perubahan transaksi (add/delete) per sumber sesi, untuk fitur
  -- rollback admin (pemulihan dari sesi/rentang waktu yang dikompromikan).
  -- snapshot: JSON {jenis, keterangan, jumlah, waktu} — cukup untuk merekonstruksi
  -- baris. sessionLabel: sumber (sid web / 'telegram:<chatId>' / 'mcp:<clientId>').
  CREATE TABLE IF NOT EXISTS transaction_audit_log (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    transactionId INTEGER,
    action TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    sessionLabel TEXT,
    performedAt INTEGER NOT NULL
  );

  -- Jejak audit tindakan admin (reset password, ubah role, dst).
  CREATE TABLE IF NOT EXISTS admin_actions (
    id TEXT PRIMARY KEY,
    adminUserId TEXT NOT NULL,
    action TEXT NOT NULL,
    targetUserId TEXT,
    detail TEXT,
    createdAt INTEGER NOT NULL
  );
`);

// Migrasi ringan untuk DB yang sudah ada sebelum kolom ini ditambahkan.
for (const column of ['telegramUsername', 'telegramName']) {
  try {
    db.exec(`ALTER TABLE telegram_links ADD COLUMN ${column} TEXT`);
  } catch {
    // Kolom sudah ada — abaikan.
  }
}
for (const column of ['displayName', 'avatarExt']) {
  try {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  } catch {
    // Kolom sudah ada — abaikan.
  }
}
try {
  db.exec(`ALTER TABLE oauth_access_tokens ADD COLUMN lastUsedAt INTEGER`);
} catch {
  // Kolom sudah ada — abaikan.
}
// picture: URL foto profil Google (dari userinfo) yang ikut disimpan bersama
// pending signup, supaya bisa diimpor jadi avatar setelah akun + username dibuat.
try {
  db.exec(`ALTER TABLE pending_google_signups ADD COLUMN picture TEXT`);
} catch {
  // Kolom sudah ada — abaikan.
}
// usernameChangedAt: timestamp perubahan username terakhir (untuk cooldown 7
// hari). NULL = belum pernah ganti, jadi tak ada cooldown yang menghalangi.
try {
  db.exec(`ALTER TABLE users ADD COLUMN usernameChangedAt INTEGER`);
} catch {
  // Kolom sudah ada — abaikan.
}
// role: 'user' | 'admin'. deletedAt: dipakai phase 3 (soft-delete) — untuk
// sekarang cuma kolom konteks yang dibaca (bukan ditulis) oleh lib/admin.js.
try {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
} catch {
  // Kolom sudah ada — abaikan.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN deletedAt INTEGER`);
} catch {
  // Kolom sudah ada — abaikan.
}
// google_id: subject ('sub') akun Google yang tertaut ke user ini (login via
// "Masuk dengan Google"). NULL untuk akun username/password biasa.
try {
  db.exec(`ALTER TABLE users ADD COLUMN google_id TEXT`);
} catch {
  // Kolom sudah ada — abaikan.
}
try {
  db.exec(`ALTER TABLE users ADD COLUMN subscription TEXT NOT NULL DEFAULT 'free'`);
} catch {
  // Kolom sudah ada — abaikan.
}

// Index untuk query batas harian: COUNT add-entries per userId per hari.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_audit_user_action_time
  ON transaction_audit_log (userId, action, performedAt)
`);

// Akun Google tidak punya password, jadi passwordHash harus boleh NULL. Skema
// lama mendeklarasikannya NOT NULL; SQLite tak bisa meng-ALTER constraint kolom,
// jadi rebuild tabel SEKALI bila masih NOT NULL (idempoten — dilewati setelahnya).
// FK tidak di-enforce (PRAGMA foreign_keys default OFF), jadi rebuild aman.
try {
  const col = db
    .prepare(`SELECT "notnull" AS nn FROM pragma_table_info('users') WHERE name = 'passwordHash'`)
    .get();
  if (col && col.nn === 1) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE users_rebuild (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        passwordHash TEXT,
        createdAt TEXT NOT NULL,
        emailVerified INTEGER NOT NULL DEFAULT 0,
        failedLoginCount INTEGER NOT NULL DEFAULT 0,
        lockedUntil INTEGER,
        displayName TEXT,
        avatarExt TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        deletedAt INTEGER,
        google_id TEXT UNIQUE,
        subscription TEXT NOT NULL DEFAULT 'free'
      );
    `);
    db.exec(`
      INSERT INTO users_rebuild
        (id, username, email, passwordHash, createdAt, emailVerified,
         failedLoginCount, lockedUntil, displayName, avatarExt, role, deletedAt, google_id, subscription)
      SELECT id, username, email, passwordHash, createdAt, emailVerified,
             failedLoginCount, lockedUntil, displayName, avatarExt, role, deletedAt, google_id, COALESCE(subscription, 'free')
      FROM users
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_rebuild RENAME TO users');
    db.exec('COMMIT');
    console.log('🔧 Migrasi: passwordHash kini nullable (dukungan akun Google).');
  }
} catch (err) {
  try { db.exec('ROLLBACK'); } catch {}
  console.error('Migrasi passwordHash nullable gagal:', err.message);
}

// --- Ekstraksi identitas ke accounts service --------------------------------
// Identitas (username/email/password/dll) & sesi sekarang dimiliki accounts
// service (/root/accounts) — lihat lib/accounts-client.js. Tabel `users` di
// atas SENGAJA DIBIARKAN APA ADANYA (tidak di-drop) sebagai snapshot beku demi
// rollback yang trivial (cukup revert kode handler, tanpa perlu pulihkan data)
// dan supaya FK userId->users(id) di tabel lain tetap valid secara skema
// (FK enforcement sendiri sudah OFF by default, jadi ini murni dokumentasi).
// Data yang MASIH lokal-UangKu (role, subscription) sekarang hidup di
// users_local, keyed by id yang sama dengan accounts service — bukan lagi di
// `users`. Migrasi sekali jalan di bawah menyalin nilai lama supaya tidak ada
// yang kehilangan role/plan-nya saat cutover.
db.exec(`
  CREATE TABLE IF NOT EXISTS users_local (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL DEFAULT 'user',
    subscription TEXT NOT NULL DEFAULT 'free'
  );
`);

try {
  const already = db.prepare(`SELECT COUNT(*) AS n FROM users_local`).get().n;
  if (already === 0) {
    const rows = db.prepare(`SELECT id, role, subscription FROM users`).all();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO users_local (id, role, subscription) VALUES (?, ?, ?)`
    );
    for (const r of rows) insert.run(r.id, r.role || 'user', r.subscription || 'free');
    if (rows.length > 0) console.log(`🔧 Migrasi: ${rows.length} baris role/subscription disalin ke users_local.`);
  }
} catch (err) {
  console.error('Migrasi users_local gagal:', err.message);
}

export default db;
