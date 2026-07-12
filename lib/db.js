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

export default db;
