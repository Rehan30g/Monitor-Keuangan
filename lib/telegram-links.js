import crypto from 'crypto';
import db from './db.js';

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 menit

function createLinkToken(chatId) {
  const token = crypto.randomBytes(24).toString('hex');
  const createdAt = Date.now();
  const expiresAt = createdAt + TOKEN_TTL_MS;
  const stmt = db.prepare(
    `INSERT INTO telegram_link_tokens (token, chatId, createdAt, expiresAt) VALUES (?, ?, ?, ?)`
  );
  stmt.run(token, String(chatId), createdAt, expiresAt);
  return { token, expiresAt };
}

function getLinkToken(token) {
  const stmt = db.prepare(`SELECT * FROM telegram_link_tokens WHERE token = ?`);
  return stmt.get(token) || null;
}

function isLinkTokenUsable(entry) {
  if (!entry) return false;
  if (entry.consumed) return false;
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

function consumeLinkToken(token) {
  const stmt = db.prepare(`UPDATE telegram_link_tokens SET consumed = 1 WHERE token = ?`);
  stmt.run(token);
}

function linkChat(chatId, userId, info = {}) {
  const stmt = db.prepare(
    `INSERT INTO telegram_links (chatId, userId, linkedAt, telegramUsername, telegramName)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chatId) DO UPDATE SET
       userId = excluded.userId,
       linkedAt = excluded.linkedAt,
       telegramUsername = excluded.telegramUsername,
       telegramName = excluded.telegramName`
  );
  stmt.run(String(chatId), userId, Date.now(), info.username || null, info.name || null);
}

function getUserIdByChat(chatId) {
  const stmt = db.prepare(`SELECT userId FROM telegram_links WHERE chatId = ?`);
  const row = stmt.get(String(chatId));
  return row ? row.userId : null;
}

function getLinkByUserId(userId) {
  const stmt = db.prepare(`SELECT * FROM telegram_links WHERE userId = ?`);
  return stmt.get(userId) || null;
}

function unlinkChat(chatId) {
  const stmt = db.prepare(`DELETE FROM telegram_links WHERE chatId = ?`);
  stmt.run(String(chatId));
}

function unlinkByUserId(userId) {
  const stmt = db.prepare(`DELETE FROM telegram_links WHERE userId = ?`);
  stmt.run(userId);
}

export {
  createLinkToken,
  getLinkToken,
  isLinkTokenUsable,
  consumeLinkToken,
  linkChat,
  getUserIdByChat,
  getLinkByUserId,
  unlinkChat,
  unlinkByUserId
};
