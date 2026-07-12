import {
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
  createVerificationCode,
  getVerificationCode,
  incrementCodeAttempts,
  consumeVerificationCode,
  isCodeUsable,
  createPasswordResetToken,
  getPasswordResetToken,
  isPasswordResetTokenUsable,
  consumePasswordResetToken,
  updateEmail,
  createEmailChangeRequest,
  getEmailChangeRequest,
  isEmailChangeRequestUsable,
  incrementEmailChangeAttempts,
  consumeEmailChangeRequest,
  SESSION_TTL_MS
} from './auth.js';
import {
  validateUsername,
  validatePassword,
  validateEmail,
  validateDisplayName,
  normalizeUsername,
  normalizeEmail
} from './validators.js';
import { extForMime, saveAvatar, removeAvatar, readAvatar } from './avatars.js';
import { createApiToken, listApiTokens, revokeApiToken } from './api-tokens.js';
import { parseJsonBody, parseCookies, sendJson, getClientIp, createRateLimiter } from './http-utils.js';
import {
  sendVerificationEmail,
  sendLoginAlertEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendDataExportEmail,
  sendAccountDeletedEmail,
  sendEmailChangeVerification,
  sendEmailChangedNotice
} from './email.js';
import { verifyCaptcha } from './captcha.js';
import { getTransactions, addTransaction, deleteTransaction } from './transactions.js';
import {
  getLinkToken,
  isLinkTokenUsable,
  consumeLinkToken,
  linkChat,
  getLinkByUserId,
  unlinkByUserId
} from './telegram-links.js';
import { sendTelegramMessage, tgApi } from './telegram-api.js';

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

  return sendJson(res, 200, {
    userId: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName || null,
    avatarUrl: user.avatarExt ? `/api/avatar/${user.id}` : null
  });
}

function getAuthUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const session = getSession(sessionId);
  if (!session) return null;

  return findUserById(session.userId);
}

const MAX_AVATAR_BYTES = 1.5 * 1024 * 1024; // 1.5 MB gambar mentah
const AVATAR_BODY_LIMIT = 2.2 * 1024 * 1024; // ruang untuk base64 (~+33%) + overhead JSON
const profileLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleUpdateProfile(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (profileLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const displayName = String(body.displayName || '').trim();
  if (!validateDisplayName(displayName)) {
    return sendJson(res, 400, { error: 'Nama panggilan harus 1-40 karakter.' });
  }

  updateDisplayName(user.id, displayName);
  return sendJson(res, 200, { message: 'Nama panggilan tersimpan.', displayName });
}

async function handleUploadAvatar(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (profileLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req, AVATAR_BODY_LIMIT);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, {
      error: err.statusCode === 413 ? 'Ukuran foto terlalu besar (maks 1.5 MB).' : 'Permintaan tidak valid.'
    });
  }

  const ext = extForMime(body.mimeType);
  if (!ext) {
    return sendJson(res, 400, { error: 'Format gambar harus PNG, JPEG, atau WEBP.' });
  }

  let buffer;
  try {
    buffer = Buffer.from(String(body.imageBase64 || ''), 'base64');
  } catch {
    return sendJson(res, 400, { error: 'Data gambar tidak valid.' });
  }

  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
    return sendJson(res, 400, { error: 'Ukuran foto terlalu besar (maks 1.5 MB).' });
  }

  saveAvatar(user.id, buffer, ext);
  updateAvatarExt(user.id, ext);

  return sendJson(res, 200, { message: 'Foto profil tersimpan.', avatarUrl: `/api/avatar/${user.id}` });
}

async function handleDeleteAvatar(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  removeAvatar(user.id);
  updateAvatarExt(user.id, null);
  return sendJson(res, 200, { message: 'Foto profil dihapus.' });
}

const passwordLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const forgotPasswordLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });

async function handleChangePassword(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (passwordLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return sendJson(res, 400, { error: 'Password saat ini salah.' });
  }
  if (!validatePassword(newPassword)) {
    return sendJson(res, 400, { error: 'Password baru minimal 8 karakter.' });
  }

  updatePassword(user.id, newPassword);

  const cookies = parseCookies(req);
  const currentSessionId = cookies[SESSION_COOKIE];
  destroyAllSessionsForUser(user.id, currentSessionId);

  sendPasswordChangedEmail(user.email).catch((err) =>
    console.error('Gagal mengirim notifikasi ganti password:', err.message)
  );

  return sendJson(res, 200, { message: 'Password berhasil diubah.' });
}

const emailChangeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });

async function handleRequestEmailChange(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (emailChangeLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const currentPassword = String(body.currentPassword || '');
  const newEmail = normalizeEmail(body.newEmail || '');

  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return sendJson(res, 400, { error: 'Password salah.' });
  }
  if (!validateEmail(newEmail)) {
    return sendJson(res, 400, { error: 'Alamat email tidak valid.' });
  }
  if (newEmail === user.email) {
    return sendJson(res, 400, { error: 'Email baru sama dengan email saat ini.' });
  }
  if (findUserByEmail(newEmail)) {
    return sendJson(res, 409, { error: 'Email tersebut sudah digunakan akun lain.' });
  }

  const { token, code } = createEmailChangeRequest(user.id, newEmail);
  sendEmailChangeVerification(newEmail, code).catch((err) =>
    console.error('Gagal mengirim kode verifikasi email baru:', err.message)
  );

  return sendJson(res, 200, {
    message: 'Kode verifikasi telah dikirim ke email baru kamu.',
    verifyToken: token
  });
}

async function handleConfirmEmailChange(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
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

  const entry = getEmailChangeRequest(token);
  if (!entry || entry.userId !== user.id || !isEmailChangeRequestUsable(entry)) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }
  if (entry.code !== code) {
    incrementEmailChangeAttempts(token);
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }
  if (findUserByEmail(entry.newEmail)) {
    return sendJson(res, 409, { error: 'Email tersebut sudah digunakan akun lain.' });
  }

  consumeEmailChangeRequest(token);
  const oldEmail = user.email;
  updateEmail(user.id, entry.newEmail);

  sendEmailChangedNotice(oldEmail, entry.newEmail).catch((err) =>
    console.error('Gagal mengirim notifikasi ganti email:', err.message)
  );

  return sendJson(res, 200, { message: 'Email berhasil diubah.', email: entry.newEmail });
}

const tokenLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const tokenCreateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleListTokens(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  return sendJson(res, 200, { tokens: listApiTokens(user.id) });
}

async function handleCreateToken(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenCreateLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const label = String(body.label || '').trim().slice(0, 60);
  if (!label) {
    return sendJson(res, 400, { error: 'Label token tidak boleh kosong.' });
  }

  const created = createApiToken(user.id, label);
  return sendJson(res, 200, created);
}

async function handleRevokeToken(req, res, tokenId) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  const ok = revokeApiToken(user.id, tokenId);
  if (!ok) {
    return sendJson(res, 404, { error: 'Token tidak ditemukan.' });
  }
  return sendJson(res, 200, { ok: true });
}

async function handleForgotPassword(req, res) {
  if (forgotPasswordLimiter(getClientIp(req))) {
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

  const email = normalizeEmail(body.email || '');
  // Respons selalu sama baik email terdaftar atau tidak — mencegah enumerasi akun.
  const genericMessage = {
    message: 'Jika email tersebut terdaftar, kami sudah mengirim link reset password ke sana.'
  };

  if (!validateEmail(email)) {
    return sendJson(res, 200, genericMessage);
  }

  const user = findUserByEmail(email);
  if (user) {
    const { token } = createPasswordResetToken(user.id);
    const resetLink = `${process.env.PUBLIC_BASE_URL || 'https://huzky.xyz'}/reset-password?token=${token}`;
    sendPasswordResetEmail(user.email, resetLink).catch((err) =>
      console.error('Gagal mengirim email reset password:', err.message)
    );
  }

  return sendJson(res, 200, genericMessage);
}

async function handleResetPassword(req, res) {
  if (forgotPasswordLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const token = String(body.token || '');
  const newPassword = String(body.newPassword || '');

  const entry = getPasswordResetToken(token);
  if (!isPasswordResetTokenUsable(entry)) {
    return sendJson(res, 400, { error: 'Link reset password tidak valid atau sudah kedaluwarsa.' });
  }
  if (!validatePassword(newPassword)) {
    return sendJson(res, 400, { error: 'Password baru minimal 8 karakter.' });
  }

  consumePasswordResetToken(token);
  updatePassword(entry.userId, newPassword);
  destroyAllSessionsForUser(entry.userId);

  const user = findUserById(entry.userId);
  if (user) {
    sendPasswordChangedEmail(user.email).catch((err) =>
      console.error('Gagal mengirim notifikasi ganti password:', err.message)
    );
  }

  return sendJson(res, 200, { message: 'Password berhasil direset. Silakan login dengan password baru.' });
}

function csvField(value) {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildTransactionsCsv(transaksi) {
  const header = ['Tanggal', 'Jenis', 'Keterangan', 'Jumlah'];
  const rows = transaksi.map((t) => [
    t.waktu,
    t.jenis === 'masuk' ? 'Pemasukan' : 'Pengeluaran',
    t.keterangan,
    t.jumlah
  ]);
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n');
}

const exportLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 3 });

async function handleExportData(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (exportLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  const { transaksi } = getTransactions(user.id);
  const csv = buildTransactionsCsv(transaksi);

  sendDataExportEmail(user.email, user.username, csv).catch((err) =>
    console.error('Gagal mengirim email ekspor data:', err.message)
  );

  return sendJson(res, 200, { message: 'Data kamu sedang dikirim ke email — cek inbox dalam beberapa menit.' });
}

const deleteAccountLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });

async function handleDeleteAccount(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (deleteAccountLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const password = String(body.password || '');
  if (!verifyPassword(password, user.passwordHash)) {
    return sendJson(res, 400, { error: 'Password salah.' });
  }

  const { username, email } = user;
  removeAvatar(user.id);
  deleteUserAccount(user.id);

  res.setHeader('Set-Cookie', expiredCookieHeader());

  sendAccountDeletedEmail(email, username).catch((err) =>
    console.error('Gagal mengirim notifikasi hapus akun:', err.message)
  );

  return sendJson(res, 200, { message: 'Akun berhasil dihapus.' });
}

const AVATAR_CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

async function handleGetAvatar(req, res, userId) {
  const user = findUserById(userId);
  if (!user || !user.avatarExt) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  const buffer = readAvatar(userId, user.avatarExt);
  if (!buffer) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  res.writeHead(200, {
    'Content-Type': AVATAR_CONTENT_TYPES[user.avatarExt] || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'private, max-age=300'
  });
  res.end(buffer);
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

  let chatInfo = {};
  try {
    const chatRes = await tgApi('getChat', { chat_id: entry.chatId });
    if (chatRes.ok) {
      chatInfo = {
        username: chatRes.result.username || null,
        name: [chatRes.result.first_name, chatRes.result.last_name].filter(Boolean).join(' ') || null
      };
    }
  } catch (err) {
    console.error('Gagal mengambil info chat Telegram:', err.message);
  }

  linkChat(entry.chatId, user.id, chatInfo);

  sendTelegramMessage(
    entry.chatId,
    `Berhasil terhubung ke akun <b>${user.username}</b>. Kirim foto struk atau catatan teks untuk mulai mencatat transaksi.`
  ).catch((err) => console.error('Gagal mengirim notifikasi Telegram:', err.message));

  return sendJson(res, 200, { message: 'Chat Telegram berhasil dihubungkan ke akun kamu.' });
}

async function handleGetTelegramStatus(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  const link = getLinkByUserId(user.id);
  if (!link) {
    return sendJson(res, 200, { linked: false });
  }

  return sendJson(res, 200, {
    linked: true,
    username: link.telegramUsername || null,
    name: link.telegramName || null,
    linkedAt: link.linkedAt
  });
}

async function handleTelegramUnlink(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  const link = getLinkByUserId(user.id);
  if (link) {
    unlinkByUserId(user.id);
    sendTelegramMessage(
      link.chatId,
      `Chat ini sudah diputus dari akun <b>${user.username}</b>. Ketik /login lagi kapan pun untuk menghubungkan ulang.`
    ).catch((err) => console.error('Gagal mengirim notifikasi Telegram:', err.message));
  }

  return sendJson(res, 200, { message: 'Akun Telegram berhasil diputus.' });
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
  handleTelegramConfirmLink,
  handleGetTelegramStatus,
  handleTelegramUnlink,
  handleUpdateProfile,
  handleUploadAvatar,
  handleDeleteAvatar,
  handleGetAvatar,
  handleChangePassword,
  handleForgotPassword,
  handleResetPassword,
  handleExportData,
  handleDeleteAccount,
  handleRequestEmailChange,
  handleConfirmEmailChange,
  handleListTokens,
  handleCreateToken,
  handleRevokeToken
};
