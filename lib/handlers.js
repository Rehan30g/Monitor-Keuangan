import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  createUser,
  findUserByUsername,
  findUserById,
  registerFailedLogin,
  resetFailedLogins,
  isLocked,
  createSession,
  getSession,
  destroySession,
  markEmailVerified,
  createVerificationCode,
  getVerificationCode,
  incrementCodeAttempts,
  consumeVerificationCode,
  isCodeUsable,
  SESSION_TTL_MS
} from './auth.js';
import {
  validateUsername,
  validatePassword,
  validateEmail,
  normalizeUsername,
  normalizeEmail
} from './validators.js';
import { parseJsonBody, parseCookies, sendJson, getClientIp, createRateLimiter } from './http-utils.js';
import { sendVerificationEmail, sendLoginAlertEmail } from './email.js';
import { verifyCaptcha } from './captcha.js';
import { getTransactions, addTransaction, deleteTransaction } from './transactions.js';
import { getLinkToken, isLinkTokenUsable, consumeLinkToken, linkChat } from './telegram-links.js';
import { sendTelegramMessage } from './telegram-api.js';

const registerLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const loginLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const resendLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 3 });
const codeVerifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

const SESSION_COOKIE = 'sid';
const GENERIC_CODE_ERROR = { error: 'Kode salah, kedaluwarsa, atau sudah dipakai.' };
const CAPTCHA_ERROR = { error: 'Verifikasi captcha gagal. Silakan coba lagi.' };

function sessionCookieHeader(sessionId, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

function expiredCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function issueAndSendVerifyCode(user) {
  const { id: token, code } = createVerificationCode(user.id, 'register_verify');
  await sendVerificationEmail(user.email, code);
  return token;
}

async function handleRegister(req, res) {
  if (registerLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const captchaOk = await verifyCaptcha(body.captchaToken, getClientIp(req));
  if (!captchaOk) {
    return sendJson(res, 400, CAPTCHA_ERROR);
  }

  const username = normalizeUsername(body.username || '');
  const email = normalizeEmail(body.email || '');
  const password = String(body.password || '');

  if (!validateUsername(username)) {
    return sendJson(res, 400, {
      error: 'Username harus 3-32 karakter, hanya huruf/angka/underscore.'
    });
  }
  if (!validateEmail(email)) {
    return sendJson(res, 400, { error: 'Alamat email tidak valid.' });
  }
  if (!validatePassword(password)) {
    return sendJson(res, 400, { error: 'Password minimal 8 karakter.' });
  }

  let user;
  try {
    user = createUser(username, email, password);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return sendJson(res, 409, { error: 'Username atau email sudah digunakan.' });
    }
    console.error('Register error:', err.message);
    return sendJson(res, 500, { error: 'Terjadi kesalahan pada server.' });
  }

  const verifyToken = await issueAndSendVerifyCode(user);

  return sendJson(res, 201, {
    message: 'Registrasi berhasil. Kode verifikasi telah dikirim ke email kamu.',
    verifyToken
  });
}

async function handleVerifyEmail(req, res) {
  if (codeVerifyLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const token = String(body.token || '');
  const code = String(body.code || '').trim();

  const entry = getVerificationCode(token, 'register_verify');
  if (!isCodeUsable(entry)) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  if (entry.code !== code) {
    incrementCodeAttempts(token);
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  consumeVerificationCode(token);
  markEmailVerified(entry.userId);

  return sendJson(res, 200, { message: 'Email berhasil diverifikasi. Silakan login.' });
}

async function handleResendCode(req, res) {
  if (resendLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan kirim ulang. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const token = String(body.token || '');

  const entry = getVerificationCode(token, 'register_verify');
  if (!entry) {
    return sendJson(res, 400, { error: 'Permintaan tidak valid.' });
  }

  const user = findUserById(entry.userId);
  if (!user) {
    return sendJson(res, 400, { error: 'Permintaan tidak valid.' });
  }

  const newToken = await issueAndSendVerifyCode(user);
  return sendJson(res, 200, { message: 'Kode baru telah dikirim ke email kamu.', token: newToken });
}

async function handleLogin(req, res) {
  if (loginLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const captchaOk = await verifyCaptcha(body.captchaToken, getClientIp(req));
  if (!captchaOk) {
    return sendJson(res, 400, CAPTCHA_ERROR);
  }

  const username = normalizeUsername(body.username || '');
  const password = String(body.password || '');
  const genericError = { error: 'Username atau password salah.' };

  const user = findUserByUsername(username);

  if (!user) {
    // Tetap lakukan verifikasi dummy agar waktu respons konsisten (anti-enumeration).
    verifyPassword(password, DUMMY_HASH);
    return sendJson(res, 401, genericError);
  }

  if (isLocked(user)) {
    return sendJson(res, 429, { error: 'Akun terkunci sementara. Coba lagi nanti.' });
  }

  const valid = verifyPassword(password, user.passwordHash);
  if (!valid) {
    registerFailedLogin(user);
    return sendJson(res, 401, genericError);
  }

  resetFailedLogins(user);

  if (!user.emailVerified) {
    const verifyToken = await issueAndSendVerifyCode(user);
    return sendJson(res, 403, {
      error: 'Email belum diverifikasi. Kode verifikasi baru telah dikirim.',
      needsVerification: true,
      verifyToken
    });
  }

  const session = createSession(user.id);
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', sessionCookieHeader(session.id, maxAgeSeconds));

  sendLoginAlertEmail(user.email, {
    username: user.username,
    time: new Date().toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'medium' }),
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || 'Tidak diketahui'
  }).catch((err) => console.error('Gagal mengirim notifikasi login:', err.message));

  return sendJson(res, 200, { message: 'Login berhasil.', username: user.username });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) {
    destroySession(sessionId);
  }
  res.setHeader('Set-Cookie', expiredCookieHeader());
  return sendJson(res, 200, { message: 'Logout berhasil.' });
}

async function handleMe(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  const session = getSession(sessionId);
  if (!session) {
    return sendJson(res, 401, { error: 'Sesi tidak valid atau kedaluwarsa.' });
  }

  const user = findUserById(session.userId);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  return sendJson(res, 200, { username: user.username });
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const session = getSession(sessionId);
  if (!session) return null;

  return findUserById(session.userId);
}

async function handleGetTransactions(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  const data = getTransactions(user.id);
  return sendJson(res, 200, data);
}

async function handleCreateTransaction(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const { jenis, keterangan, jumlah } = body;
  let cleanedJumlah = String(jumlah || '').replace(/\./g, '').replace(/,/g, '').trim();

  const result = addTransaction(user.id, jenis, keterangan, cleanedJumlah);
  if (result.error) {
    return sendJson(res, 400, result);
  }
  return sendJson(res, 200, result);
}

async function handleDeleteTransaction(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const id = parseInt(body.id, 10);
  if (isNaN(id)) {
    return sendJson(res, 400, { error: 'ID transaksi tidak valid.' });
  }

  const result = deleteTransaction(user.id, id);
  if (result.error) {
    return sendJson(res, 400, result);
  }
  return sendJson(res, 200, result);
}

const telegramLinkLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleTelegramConfirmLink(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  if (telegramLinkLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const token = String(body.token || '');
  const entry = getLinkToken(token);
  if (!isLinkTokenUsable(entry)) {
    return sendJson(res, 400, { error: 'Link tidak valid atau sudah kedaluwarsa.' });
  }

  consumeLinkToken(token);
  linkChat(entry.chatId, user.id);

  sendTelegramMessage(
    entry.chatId,
    `Berhasil terhubung ke akun <b>${user.username}</b>. Kirim foto struk atau catatan teks untuk mulai mencatat transaksi.`
  ).catch((err) => console.error('Gagal mengirim notifikasi Telegram:', err.message));

  return sendJson(res, 200, { message: 'Chat Telegram berhasil dihubungkan ke akun kamu.' });
}

export {
  handleRegister,
  handleVerifyEmail,
  handleResendCode,
  handleLogin,
  handleLogout,
  handleMe,
  handleGetTransactions,
  handleCreateTransaction,
  handleDeleteTransaction,
  handleTelegramConfirmLink
};
