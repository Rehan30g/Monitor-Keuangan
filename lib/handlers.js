// Identitas (register/login/sesi/password/email/avatar/dll) sekarang dimiliki
// accounts service — lihat lib/accounts-client.js. Handler di bawah jadi proxy
// tipis: validasi sesi + orkestrasi lokal (MFA, login_history, cookie) tetap di
// sini, tapi query/tulis data identitas selalu lewat panggilan HTTP internal.
import { accounts } from './accounts-client.js';
import {
  validateUsername,
  validatePassword,
  validateEmail,
  validateDisplayName,
  normalizeUsername,
  normalizeEmail
} from './validators.js';
import { createApiToken, listApiTokens, revokeApiToken } from './api-tokens.js';
import { listConnectedClients, revokeClientForUser } from './oauth-store.js';
import { parseJsonBody, parseCookies, sendJson, getClientIp, createRateLimiter } from './http-utils.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sendDataExportEmail,
  sendMfaEnabledEmail,
  sendMfaDisabledEmail
} from './email.js';
import { verifyTotp, buildOtpauthUri } from './totp.js';
import {
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
  consumeLoginChallenge
} from './mfa.js';
import {
  recordLoginHistory,
  listUsers,
  getUserDetail,
  setUserRole,
  restoreUserAccount,
  resetUsernameCooldown,
  listDeletedAccounts,
  listTransactionSessions,
  previewRollback,
  rollbackTransactions,
  logAdminAction
} from './admin.js';
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
import { isGoogleConfigured, createState, consumeState, buildAuthUrl } from './google-oauth.js';
import { verifySubscriptionPayment } from './openrouter.js';
import db from './db.js';

const registerLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const loginLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const resendLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 3 });
const codeVerifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

const SESSION_COOKIE = 'sid';

// --- Local role/subscription (users_local, keyed by accounts-service id) ---
function getLocalUser(userId) {
  return db.prepare(`SELECT * FROM users_local WHERE id = ?`).get(userId)
    || { id: userId, role: 'user', subscription: 'free' };
}
function ensureLocalUser(userId) {
  db.prepare(`INSERT OR IGNORE INTO users_local (id, role, subscription) VALUES (?, 'user', 'free')`).run(userId);
}
function updateUserSubscription(userId, subscription) {
  ensureLocalUser(userId);
  db.prepare(`UPDATE users_local SET subscription = ? WHERE id = ?`).run(subscription, userId);
}
const GENERIC_CODE_ERROR = { error: 'Kode salah, kedaluwarsa, atau sudah dipakai.' };
const CAPTCHA_ERROR = { error: 'Verifikasi captcha gagal. Silakan coba lagi.' };

// SameSite=Lax (bukan Strict) SENGAJA — supaya cookie sesi ini tetap terkirim
// saat konektor eksternal (mis. Claude.ai) me-redirect top-level browser ke
// /authorize (alur OAuth MCP). Strict memblokir cookie pada navigasi top-level
// lintas situs, jadi user yang sudah login akan dipaksa login+2FA ulang tiap
// kali connect — persis pola yang sudah diperbaiki utk g_oauth_state di bawah.
// Lax tetap aman dari CSRF pada request POST lintas situs (cookie tak ikut).
function sessionCookieHeader(sessionId, maxAgeSeconds) {
  return `${SESSION_COOKIE}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function expiredCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function handleRegister(req, res) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }
  const r = await accounts.post('/internal/register', { ...body, ip: getClientIp(req) });
  return sendJson(res, r.status, r.body);
}

async function handleVerifyEmail(req, res) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }
  const r = await accounts.post('/internal/verify-email', { ...body, ip: getClientIp(req) });
  return sendJson(res, r.status, r.body);
}

async function handleResendCode(req, res) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }
  const r = await accounts.post('/internal/resend-code', { ...body, ip: getClientIp(req) });
  return sendJson(res, r.status, r.body);
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const cred = await accounts.post('/internal/login/credentials', { ...body, ip: getClientIp(req) });
  if (cred.status !== 200 || !cred.body.ok) {
    // Kredensial salah/terkunci/rate-limited/email belum diverifikasi — teruskan
    // apa adanya. userId (bila ada) cuma dipakai buat login_history di bawah,
    // TIDAK ikut diteruskan ke client.
    if (cred.body && cred.body.userId) {
      recordLoginHistory({
        userId: cred.body.userId,
        ip: getClientIp(req),
        userAgent: req.headers['user-agent'] || null,
        success: false
      });
    }
    const { userId, ...publicBody } = cred.body || {};
    return sendJson(res, cred.status, publicBody);
  }

  const { userId, username } = cred.body;

  // MFA aktif: JANGAN terbitkan sesi dulu. Buat challenge singkat & minta kode
  // di langkah kedua (tanpa Set-Cookie). Sesi baru dibuat di handleLoginMfa.
  if (isMfaEnabled(userId)) {
    const challenge = createLoginChallenge(userId);
    return sendJson(res, 200, { mfaRequired: true, challengeId: challenge.id });
  }

  await issueSessionAndRespond(req, res, userId, username);
}

// Terbitkan sesi (via accounts service) + Set-Cookie, catat login_history
// (lokal, tetap milik UangKu), balas sukses. Dipakai oleh handleLogin
// (tanpa MFA), handleLoginMfa (setelah kode terverifikasi), dan alur Google.
async function establishSession(req, res, userId) {
  const r = await accounts.post('/internal/sessions', {
    userId,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || null
  });
  if (r.status !== 200) return null;

  const maxAgeSeconds = Math.max(0, Math.floor((r.body.expiresAt - Date.now()) / 1000));
  res.setHeader('Set-Cookie', sessionCookieHeader(r.body.sessionId, maxAgeSeconds));

  ensureLocalUser(userId);
  recordLoginHistory({
    userId,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    success: true
  });

  return r.body.user;
}

async function issueSessionAndRespond(req, res, userId, username) {
  const user = await establishSession(req, res, userId);
  if (!user) return sendJson(res, 500, { error: 'Terjadi kesalahan pada server.' });
  return sendJson(res, 200, { message: 'Login berhasil.', username: user.username || username });
}

// Langkah kedua login untuk akun ber-MFA: verifikasi kode TOTP ATAU kode
// cadangan terhadap challenge, lalu terbitkan sesi yang sesungguhnya.
async function handleLoginMfa(req, res) {
  if (codeVerifyLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const challengeId = String(body.challengeId || '');
  const code = String(body.code || '').trim();

  const challenge = getLoginChallenge(challengeId);
  if (!isChallengeUsable(challenge)) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  const totp = getMfaTotp(challenge.userId);
  if (!totp || !totp.enabled) {
    // MFA sudah tidak aktif di tengah jalan — challenge tak berlaku lagi.
    consumeLoginChallenge(challengeId);
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  const totpOk = verifyTotp(totp.secret, code);
  const backupOk = totpOk ? false : consumeBackupCode(challenge.userId, code);

  if (!totpOk && !backupOk) {
    incrementChallengeAttempts(challengeId);
    recordLoginHistory({
      userId: challenge.userId,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
      success: false
    });
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  consumeLoginChallenge(challengeId);

  const userResp = await accounts.get(`/internal/users/${challenge.userId}`);
  if (userResp.status !== 200) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  return issueSessionAndRespond(req, res, challenge.userId, userResp.body.username);
}

// --- "Masuk dengan Google" (OAuth 2.0 Authorization Code) ----------------
const googleAuthLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

// Cookie state anti-CSRF: SameSite=Lax agar tetap terkirim saat Google me-redirect
// balik (navigasi top-level GET lintas-situs). Path dibatasi ke alur Google.
function googleStateCookie(state, maxAgeSeconds) {
  return `g_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=${maxAgeSeconds}`;
}
const GOOGLE_STATE_CLEAR = 'g_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/api/auth/google; Max-Age=0';

function redirectToLoginError(res, codeKey) {
  res.setHeader('Set-Cookie', GOOGLE_STATE_CLEAR);
  res.writeHead(302, { Location: `/login?googleError=${encodeURIComponent(codeKey)}` });
  res.end();
}

async function handleGoogleAuthStart(req, res) {
  if (googleAuthLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  if (!isGoogleConfigured()) {
    return sendJson(res, 501, { error: 'Login dengan Google belum tersedia.' });
  }
  const state = createState();
  const authUrl = buildAuthUrl(state);
  res.setHeader('Set-Cookie', googleStateCookie(state, 600));
  res.writeHead(302, { Location: authUrl });
  return res.end();
}

async function handleGoogleCallback(req, res) {
  if (googleAuthLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  if (!isGoogleConfigured()) {
    return sendJson(res, 501, { error: 'Login dengan Google belum tersedia.' });
  }

  const query = new URL(req.url, 'http://localhost').searchParams;
  const code = query.get('code');
  const state = query.get('state');
  const oauthError = query.get('error');

  if (oauthError) {
    return redirectToLoginError(res, 'google_failed');
  }

  // Validasi state: harus cocok dengan cookie (binding browser) DAN valid di
  // store server-side (single-use, TTL). Keduanya wajib untuk cegah CSRF login.
  const cookies = parseCookies(req);
  const cookieState = cookies['g_oauth_state'];
  if (!state || !cookieState || state !== cookieState || !consumeState(String(state))) {
    return redirectToLoginError(res, 'google_state');
  }
  if (!code) {
    return redirectToLoginError(res, 'google_failed');
  }

  const exchange = await accounts.post('/internal/google/exchange', { code: String(code), ip: getClientIp(req) });
  if (exchange.status !== 200 || exchange.body.kind === 'error') {
    console.error('Google OAuth callback error:', exchange.body && exchange.body.code);
    return redirectToLoginError(res, (exchange.body && exchange.body.code) || 'google_failed');
  }

  // Akun baru: JANGAN buat langsung. Token pending (single-use, TTL) sudah
  // dibuat oleh accounts service — arahkan user memilih username sendiri.
  if (exchange.body.kind === 'newSignup') {
    res.setHeader('Set-Cookie', GOOGLE_STATE_CLEAR);
    res.writeHead(302, { Location: `/google-username?token=${encodeURIComponent(exchange.body.token)}` });
    return res.end();
  }

  const user = exchange.body.user;

  // Hormati MFA: akun tertaut yang mengaktifkan MFA tetap harus tantangan kode.
  // Buat challenge & arahkan ke /login yang membuka sheet MFA (POST /api/login/mfa).
  if (isMfaEnabled(user.id)) {
    const challenge = createLoginChallenge(user.id);
    res.setHeader('Set-Cookie', GOOGLE_STATE_CLEAR);
    res.writeHead(302, { Location: `/login?mfaChallenge=${encodeURIComponent(challenge.id)}` });
    return res.end();
  }

  // Tanpa MFA: terbitkan sesi (jalur yang sama dengan login normal) & ke dashboard.
  await establishSession(req, res, user.id);
  // Auto-impor foto Google jadi avatar HANYA bila akun belum punya avatar.
  // Best-effort, dilakukan oleh accounts service (yang memiliki avatar storage).
  if (!user.avatarExt && exchange.body.picture) {
    accounts.post('/internal/avatar/import-google', { userId: user.id, pictureUrl: exchange.body.picture }).catch(() => {});
  }
  res.writeHead(302, { Location: '/dashboard' });
  return res.end();
}

// Selesaikan pendaftaran Google: user memilih username, lalu akun dibuat.
// Validasi + pembuatan akun sepenuhnya di accounts service — di sini cuma
// orkestrasi: terbitkan sesi (jalur yang sama dengan login Google langsung),
// balas redirect ke dashboard.
async function handleGoogleCompleteSignup(req, res) {
  if (googleAuthLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const r = await accounts.post('/internal/google/complete-signup', {
    token: String(body.token || ''),
    username: normalizeUsername(body.username || ''),
    ip: getClientIp(req)
  });
  if (r.status !== 200) return sendJson(res, r.status, r.body);

  const { user, picture } = r.body;

  // Akun baru — tak mungkin punya MFA. Terbitkan sesi persis seperti login
  // Google langsung (Set-Cookie + login_history + notifikasi login).
  await establishSession(req, res, user.id);
  if (picture && !user.avatarExt) {
    accounts.post('/internal/avatar/import-google', { userId: user.id, pictureUrl: picture }).catch(() => {});
  }
  return sendJson(res, 200, { message: 'Akun berhasil dibuat.', redirect: '/dashboard' });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) {
    accounts.del(`/internal/sessions/${sessionId}`).catch(() => {});
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

  const session = await accounts.get(`/internal/sessions/${sessionId}`);
  if (session.status !== 200) {
    return sendJson(res, 401, { error: 'Sesi tidak valid atau kedaluwarsa.' });
  }

  const user = session.body.user;
  const local = getLocalUser(user.id);

  return sendJson(res, 200, {
    userId: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName || null,
    avatarUrl: user.avatarExt ? `/api/avatar/${user.id}` : null,
    role: local.role || 'user',
    usernameChangedAt: user.usernameChangedAt || null,
    subscription: local.subscription || 'free',
    hasPassword: !!user.hasPassword
  });
}

const USERNAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari antar perubahan

// Sama seperti handleMe: validasi sesi lewat accounts service, gabungkan
// role/subscription lokal supaya handler lain yang membaca user.role /
// user.subscription tetap jalan tanpa perubahan.
async function getAuthUser(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const session = await accounts.get(`/internal/sessions/${sessionId}`);
  if (session.status !== 200) return null;

  const user = session.body.user;
  const local = getLocalUser(user.id);
  return { ...user, role: local.role, subscription: local.subscription };
}

const AVATAR_BODY_LIMIT = 2.2 * 1024 * 1024; // ruang untuk base64 (~+33%) + overhead JSON
const PAYMENT_IMAGE_LIMIT = 8 * 1024 * 1024; // 8 MB — cukup untuk foto kamera full-res base64
const profileLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleUpdateProfile(req, res) {
  const user = await getAuthUser(req);
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

  const r = await accounts.post('/internal/profile', { userId: user.id, displayName: body.displayName, ip: getClientIp(req) });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Nama panggilan tersimpan.', displayName: r.body.displayName });
}

// Ganti username sendiri, dibatasi sekali per 7 hari (cooldown, ditegakkan di
// accounts service). Admin bisa mereset cooldown lewat panel.
async function handleChangeUsername(req, res) {
  const user = await getAuthUser(req);
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

  const r = await accounts.post('/internal/username', { userId: user.id, newUsername: body.newUsername, ip: getClientIp(req) });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Username berhasil diubah.', username: r.body.username });
}

async function handleUploadAvatar(req, res) {
  const user = await getAuthUser(req);
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

  const r = await accounts.post('/internal/avatar', {
    userId: user.id, mimeType: body.mimeType, imageBase64: body.imageBase64, ip: getClientIp(req)
  });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Foto profil tersimpan.', avatarUrl: `/api/avatar/${user.id}` });
}

async function handleDeleteAvatar(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  await accounts.del(`/internal/avatar/${user.id}`);
  return sendJson(res, 200, { message: 'Foto profil dihapus.' });
}

const passwordLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const forgotPasswordLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });
const resetPasswordSubmitLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleChangePassword(req, res) {
  const user = await getAuthUser(req);
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

  const cookies = parseCookies(req);
  const currentSessionId = cookies[SESSION_COOKIE];

  // Verifikasi password lama + update + destroy sesi lain semuanya terjadi di
  // accounts service (satu-satunya pemilik password hash & tabel sessions).
  const r = await accounts.post('/internal/password/change', {
    userId: user.id,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    exceptSessionId: currentSessionId,
    ip: getClientIp(req)
  });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Password berhasil diubah.' });
}

// Untuk akun TANPA password (mis. akun Google): setel password pertama.
// Validasi "belum punya password" + update + email link darurat 14 hari
// semuanya di accounts service.
async function handleSetPassword(req, res) {
  const user = await getAuthUser(req);
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

  const r = await accounts.post('/internal/password/set', { userId: user.id, newPassword: body.newPassword, ip: getClientIp(req) });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Password berhasil dibuat.' });
}

const emailChangeLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });

async function handleRequestEmailChange(req, res) {
  const user = await getAuthUser(req);
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

  const r = await accounts.post('/internal/email/request-change', {
    userId: user.id, currentPassword: body.currentPassword, newEmail: body.newEmail, ip: getClientIp(req)
  });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Kode verifikasi telah dikirim ke email baru kamu.', verifyToken: r.body.verifyToken });
}

async function handleConfirmEmailChange(req, res) {
  const user = await getAuthUser(req);
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

  const r = await accounts.post('/internal/email/confirm-change', {
    userId: user.id, token: body.token, code: body.code, ip: getClientIp(req)
  });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
  return sendJson(res, 200, { message: 'Email berhasil diubah.', email: r.body.email });
}

const tokenLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const tokenCreateLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleListTokens(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  return sendJson(res, 200, { tokens: listApiTokens(user.id) });
}

async function handleCreateToken(req, res) {
  const user = await getAuthUser(req);
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
  const user = await getAuthUser(req);
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

async function handleListMcpConnections(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  return sendJson(res, 200, { connections: listConnectedClients(user.id) });
}

async function handleRevokeMcpConnection(req, res, clientId) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  const ok = revokeClientForUser(user.id, clientId);
  if (!ok) {
    return sendJson(res, 404, { error: 'Koneksi tidak ditemukan.' });
  }
  return sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// MFA / verifikasi dua langkah (TOTP)
// ---------------------------------------------------------------------------
const mfaLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 15 });

async function handleMfaStatus(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  return sendJson(res, 200, {
    enabled: isMfaEnabled(user.id),
    backupCodesRemaining: isMfaEnabled(user.id) ? countUnusedBackupCodes(user.id) : 0
  });
}

// Langkah 1 enroll: verifikasi ulang password, buat secret (belum aktif) +
// otpauth URI + 10 kode cadangan (ditampilkan sekali ini). enabled tetap 0
// sampai user mengonfirmasi dengan kode TOTP yang valid.
async function handleMfaEnableStart(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (mfaLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const currentPassword = String(body.currentPassword || '');
  const pwCheck = await accounts.post('/internal/password/verify', { userId: user.id, password: currentPassword });
  if (!pwCheck.body.ok) {
    return sendJson(res, 400, { error: 'Password saat ini salah.' });
  }
  if (isMfaEnabled(user.id)) {
    return sendJson(res, 409, { error: 'Verifikasi dua langkah sudah aktif.' });
  }

  const { secret } = startEnrollment(user.id);
  const backupCodes = regenerateBackupCodes(user.id);
  const otpauthUri = buildOtpauthUri(user.username, secret);

  return sendJson(res, 200, { secret, otpauthUri, backupCodes });
}

// Langkah 2 enroll: verifikasi kode TOTP terhadap secret yang belum aktif,
// lalu set enabled=1. Mencegah user terkunci karena secret salah scan/ketik.
async function handleMfaEnableConfirm(req, res) {
  const user = await getAuthUser(req);
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

  const code = String(body.code || '').trim();
  const totp = getMfaTotp(user.id);
  if (!totp) {
    return sendJson(res, 400, { error: 'Mulai pengaktifan dua langkah dulu sebelum mengonfirmasi.' });
  }
  if (totp.enabled) {
    return sendJson(res, 409, { error: 'Verifikasi dua langkah sudah aktif.' });
  }
  if (!verifyTotp(totp.secret, code)) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  enableMfa(user.id);

  sendMfaEnabledEmail(user.email).catch((err) =>
    console.error('Gagal mengirim notifikasi aktivasi 2FA:', err.message)
  );

  return sendJson(res, 200, { message: 'Verifikasi dua langkah berhasil diaktifkan.' });
}

// Nonaktifkan: butuh password DAN kode (TOTP atau kode cadangan). Dua faktor,
// supaya sesi yang dibajak tidak bisa satu klik mematikan 2FA.
async function handleMfaDisable(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (mfaLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const currentPassword = String(body.currentPassword || '');
  const code = String(body.code || '').trim();

  const pwCheck = await accounts.post('/internal/password/verify', { userId: user.id, password: currentPassword });
  if (!pwCheck.body.ok) {
    return sendJson(res, 400, { error: 'Password saat ini salah.' });
  }

  const totp = getMfaTotp(user.id);
  if (!totp || !totp.enabled) {
    return sendJson(res, 409, { error: 'Verifikasi dua langkah belum aktif.' });
  }

  const totpOk = verifyTotp(totp.secret, code);
  const backupOk = totpOk ? false : consumeBackupCode(user.id, code);
  if (!totpOk && !backupOk) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  disableMfa(user.id);

  sendMfaDisabledEmail(user.email).catch((err) =>
    console.error('Gagal mengirim notifikasi nonaktif 2FA:', err.message)
  );

  return sendJson(res, 200, { message: 'Verifikasi dua langkah berhasil dinonaktifkan.' });
}

// Buat ulang kode cadangan: butuh password, buang kode lama, buat 10 baru.
async function handleMfaRegenerateBackup(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (mfaLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const currentPassword = String(body.currentPassword || '');
  const pwCheck = await accounts.post('/internal/password/verify', { userId: user.id, password: currentPassword });
  if (!pwCheck.body.ok) {
    return sendJson(res, 400, { error: 'Password saat ini salah.' });
  }
  if (!isMfaEnabled(user.id)) {
    return sendJson(res, 409, { error: 'Verifikasi dua langkah belum aktif.' });
  }

  const backupCodes = regenerateBackupCodes(user.id);
  return sendJson(res, 200, { backupCodes });
}

async function handleForgotPassword(req, res) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }
  // Respons selalu sama baik email terdaftar atau tidak — mencegah enumerasi
  // akun; sisi accounts service juga tidak membedakan lewat status/isi respons.
  await accounts.post('/internal/password/forgot', { ...body, ip: getClientIp(req) });
  return sendJson(res, 200, {
    message: 'Jika email tersebut terdaftar, kami sudah mengirim link reset password ke sana.'
  });
}

async function handleResetPassword(req, res) {
  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }
  const r = await accounts.post('/internal/password/reset', { ...body, ip: getClientIp(req) });
  if (r.status !== 200) return sendJson(res, r.status, r.body);
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
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if ((user.subscription || 'free') !== 'max') {
    return sendJson(res, 403, { error: 'Ekspor data hanya untuk pelanggan Max.' });
  }
  if (exportLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  const { transaksi } = getTransactions(user.id);
  const csv = buildTransactionsCsv(transaksi);

  sendDataExportEmail(user.email, user.username, csv).catch((err) =>
    console.error('Gagal mengirim email ekspor data:', err.message)
  );

  return sendJson(res, 200, { message: 'Data kamu sedang dikirim ke email. Cek inbox dalam beberapa menit.' });
}

const deleteAccountLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 5 });

async function handleDeleteAccount(req, res) {
  const user = await getAuthUser(req);
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

  // Verifikasi password + soft-delete (deletedAt + bunuh semua sesi) + email
  // notifikasi semuanya di accounts service. Data lokal UangKu (transactions,
  // dll) sengaja DIBIARKAN agar akun bisa dipulihkan utuh dalam 7 hari —
  // dibersihkan permanen lewat webhook /internal/hooks/user-purged nanti.
  const r = await accounts.post('/internal/account/delete', { userId: user.id, password: body.password, ip: getClientIp(req) });
  if (r.status !== 200) return sendJson(res, r.status, r.body);

  res.setHeader('Set-Cookie', expiredCookieHeader());
  return sendJson(res, 200, { message: 'Akun berhasil dihapus.' });
}

// Proxy tipis: file avatar sesungguhnya disimpan & di-serve oleh accounts
// service, endpoint publik ini tetap di UangKu supaya URL /api/avatar/:userId
// yang sudah beredar (dashboard, dll) tidak berubah.
async function handleGetAvatar(req, res, userId) {
  const upstream = await fetch(`${accounts.baseUrl}/internal/avatar/${userId}`, {
    headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' }
  });
  if (!upstream.ok) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'private, max-age=300'
  });
  res.end(buffer);
}

const subscriptionVerifyLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

async function handleVerifySubscriptionPayment(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }

  if (subscriptionVerifyLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak percobaan verifikasi pembayaran. Coba lagi nanti.' });
  }

  let body;
  try {
    body = await parseJsonBody(req, PAYMENT_IMAGE_LIMIT);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const { imageBase64, imageMime, plan } = body;
  if (!imageBase64) {
    return sendJson(res, 400, { error: 'Foto bukti pembayaran diperlukan.' });
  }
  if (plan !== 'lite' && plan !== 'pro' && plan !== 'max') {
    return sendJson(res, 400, { error: 'Plan langganan tidak valid.' });
  }

  try {
    const result = await verifySubscriptionPayment({ imageBase64, imageMime, plan });
    const safeReason = typeof result.reason === 'string' ? result.reason.slice(0, 300) : '';
    if (result.approved) {
      updateUserSubscription(user.id, plan);
      return sendJson(res, 200, { success: true, message: safeReason || 'Pembayaran berhasil dikonfirmasi!' });
    } else {
      return sendJson(res, 400, { error: safeReason || 'Verifikasi gagal. Pembayaran tidak terdeteksi.' });
    }
  } catch (err) {
    console.error('Subscription verification error:', err);
    return sendJson(res, 500, { error: 'Gagal melakukan verifikasi pembayaran via AI. Coba lagi nanti.' });
  }
}

async function handleGetTransactions(req, res) {
  const user = await getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  const data = getTransactions(user.id);
  return sendJson(res, 200, data);
}

async function handleCreateTransaction(req, res) {
  const user = await getAuthUser(req);
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

  const sessionId = parseCookies(req)[SESSION_COOKIE] || null;
  const result = addTransaction(user.id, jenis, keterangan, cleanedJumlah, { sessionLabel: sessionId });
  if (result.error) {
    return sendJson(res, 400, result);
  }
  return sendJson(res, 200, result);
}

async function handleDeleteTransaction(req, res) {
  const user = await getAuthUser(req);
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

  const sessionId = parseCookies(req)[SESSION_COOKIE] || null;
  const result = deleteTransaction(user.id, id, { sessionLabel: sessionId });
  if (result.error) {
    return sendJson(res, 400, result);
  }
  return sendJson(res, 200, result);
}

const telegramLinkLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

async function handleTelegramConfirmLink(req, res) {
  const user = await getAuthUser(req);
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
  const user = await getAuthUser(req);
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
  const user = await getAuthUser(req);
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

// ---------------------------------------------------------------------------
// Panel admin
// ---------------------------------------------------------------------------
const adminLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

// Gerbang akses admin. Mengembalikan { user } jika lolos, atau kode alasan
// yang membedakan "belum login" / "bukan admin" / "wajib 2FA" supaya klien
// bisa memilih status HTTP & pesan yang tepat.
async function requireAdmin(req) {
  const user = await getAuthUser(req);
  if (!user) return { error: 'unauthenticated' };
  if (user.role !== 'admin') return { error: 'not_admin' };
  if (!isMfaEnabled(user.id)) return { error: 'mfa_required' };
  return { user };
}

// Terjemahkan alasan requireAdmin ke respons HTTP. Mengembalikan true bila
// sudah membalas (gagal), false bila lolos.
function denyIfNotAdmin(res, gate) {
  if (gate.user) return false;
  if (gate.error === 'unauthenticated') {
    sendJson(res, 401, { error: 'Belum login.' });
  } else if (gate.error === 'mfa_required') {
    sendJson(res, 403, { error: 'Aktifkan verifikasi dua langkah dulu untuk mengakses panel admin.', reason: 'mfa_required' });
  } else {
    sendJson(res, 403, { error: 'Akses ditolak.', reason: 'not_admin' });
  }
  return true;
}

async function handleAdminListUsers(req, res) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  return sendJson(res, 200, { users: await listUsers() });
}

async function handleAdminGetUser(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const detail = await getUserDetail(targetUserId);
  if (!detail) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }
  return sendJson(res, 200, { user: detail });
}

// Admin memicu reset password: pakai persis alur self-service (forgot-password),
// yang saat ini juga dijalankan sepenuhnya oleh accounts service. Admin tak
// pernah menetapkan/melihat password — hanya menyebabkan email reset yang sama.
async function handleAdminResetPassword(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = await getUserDetail(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  await accounts.post('/internal/password/forgot', { email: target.email, ip: getClientIp(req) });

  logAdminAction({
    adminUserId: gate.user.id,
    action: 'reset_password',
    targetUserId: target.id,
    detail: `email: ${target.email}`
  });

  return sendJson(res, 200, { ok: true, message: 'Email reset password telah dikirim ke pengguna.' });
}

async function handleAdminSetRole(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const newRole = String(body.role || '');
  const target = await getUserDetail(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }
  const oldRole = target.role || 'user';

  const result = await setUserRole(targetUserId, newRole);
  if (result.error === 'invalid_role') {
    return sendJson(res, 400, { error: 'Role tidak valid.' });
  }
  if (result.error === 'not_found') {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }
  if (result.error === 'last_admin') {
    return sendJson(res, 400, { error: 'Tidak bisa mencabut admin terakhir.', reason: 'last_admin' });
  }

  logAdminAction({
    adminUserId: gate.user.id,
    action: 'set_role',
    targetUserId,
    detail: `role: ${oldRole} -> ${newRole}`
  });

  return sendJson(res, 200, { ok: true, user: result.user });
}

async function handleAdminSetSubscription(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const newSub = String(body.subscription || '').toLowerCase().trim();
  const allowed = ['free', 'lite', 'pro', 'max'];
  if (!allowed.includes(newSub)) {
    return sendJson(res, 400, { error: 'Plan tidak valid.' });
  }

  const target = await getUserDetail(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  updateUserSubscription(targetUserId, newSub);

  logAdminAction({
    adminUserId: gate.user.id,
    action: 'set_subscription',
    targetUserId,
    detail: `subscription: ${target.subscription || 'free'} -> ${newSub}`
  });

  const updatedTarget = await getUserDetail(targetUserId);
  return sendJson(res, 200, { ok: true, user: updatedTarget });
}

// Daftar akun soft-deleted yang masih dalam masa tenggang 7 hari, lengkap
// dengan daysRemaining untuk ditampilkan di panel admin.
async function handleAdminListDeleted(req, res) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  return sendJson(res, 200, { accounts: await listDeletedAccounts() });
}

// Pulihkan akun soft-deleted (batalkan deletedAt). Tidak menyentuh data lain.
async function handleAdminRestoreUser(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = await getUserDetail(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  const result = await restoreUserAccount(targetUserId);
  if (result.error === 'not_found') {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }
  if (result.error === 'not_deleted') {
    return sendJson(res, 400, { error: 'Akun ini tidak sedang dalam status terhapus.', reason: 'not_deleted' });
  }

  logAdminAction({
    adminUserId: gate.user.id,
    action: 'restore_account',
    targetUserId,
    detail: `username: ${target.username}`
  });

  return sendJson(res, 200, { ok: true, user: result.user });
}

// Reset cooldown ganti username milik satu user (set usernameChangedAt = NULL).
// Mengikuti pola requireAdmin/denyIfNotAdmin/logAdminAction seperti set-role.
async function handleAdminResetUsernameCooldown(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = await getUserDetail(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  const result = await resetUsernameCooldown(targetUserId);
  if (result.error === 'not_found') {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  logAdminAction({
    adminUserId: gate.user.id,
    action: 'reset_username_cooldown',
    targetUserId,
    detail: `username: ${target.username}`
  });

  return sendJson(res, 200, { ok: true, user: result.user });
}

// --- Rollback transaksi (audit) --------------------------------------------

// Daftar sesi audit transaksi milik satu user (untuk memilih sesi yang mau
// di-rollback). Read-only.
async function handleAdminListTxSessions(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const targetExists = await accounts.get(`/internal/users/${targetUserId}`);
  if (targetExists.status !== 200) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  return sendJson(res, 200, { sessions: listTransactionSessions(targetUserId) });
}

// Ambil kriteria { sessionLabel } ATAU { fromTime, toTime } dari body dengan
// normalisasi angka untuk rentang waktu.
function parseRollbackCriteria(body) {
  if (body && body.sessionLabel != null && body.sessionLabel !== '') {
    return { sessionLabel: String(body.sessionLabel) };
  }
  if (body && body.fromTime != null && body.toTime != null) {
    return { fromTime: Number(body.fromTime), toTime: Number(body.toTime) };
  }
  return {};
}

// Pratinjau rollback: apa yang akan dipulihkan/dihapus, tanpa mengeksekusi.
async function handleAdminPreviewRollback(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const targetExists = await accounts.get(`/internal/users/${targetUserId}`);
  if (targetExists.status !== 200) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const result = previewRollback(targetUserId, parseRollbackCriteria(body));
  if (result.error === 'invalid_criteria') {
    return sendJson(res, 400, { error: 'Kriteria rollback tidak valid.', reason: 'invalid_criteria' });
  }
  return sendJson(res, 200, result);
}

// Eksekusi rollback transaksi untuk satu akun berdasar sesi atau rentang waktu.
async function handleAdminRollback(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = await requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const targetExists = await accounts.get(`/internal/users/${targetUserId}`);
  if (targetExists.status !== 200) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const criteria = parseRollbackCriteria(body);
  const result = rollbackTransactions(targetUserId, criteria);
  if (result.error === 'invalid_criteria') {
    return sendJson(res, 400, { error: 'Kriteria rollback tidak valid.', reason: 'invalid_criteria' });
  }

  logAdminAction({
    adminUserId: gate.user.id,
    action: 'tx_rollback',
    targetUserId,
    detail: JSON.stringify({ ...criteria, restored: result.restored, removed: result.removed })
  });

  return sendJson(res, 200, { ok: true, ...result });
}

const DASHBOARD_HTML_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'dashboard.html');
let dashboardHtmlCache = null;

async function handleDashboardPage(req, res) {
  if (!dashboardHtmlCache) {
    dashboardHtmlCache = await fs.readFile(DASHBOARD_HTML_PATH, 'utf8');
  }
  const user = await getAuthUser(req);
  let html = dashboardHtmlCache;
  if (!user || user.role !== 'admin') {
    // Non-admin: tautan panel admin dihapus sepenuhnya dari markup yang
    // dikirim, bukan cuma disembunyikan lewat CSS/JS — tidak bisa ditemukan
    // lewat Inspect Element sebagai user biasa.
    html = html.replace(/<!--ADMIN_NAV_START-->[\s\S]*?<!--ADMIN_NAV_END-->/, '');
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store'
  });
  res.end(html);
}

export {
  handleRegister,
  handleVerifyEmail,
  handleResendCode,
  handleLogin,
  handleLoginMfa,
  handleGoogleAuthStart,
  handleGoogleCallback,
  handleGoogleCompleteSignup,
  handleLogout,
  handleMe,
  handleVerifySubscriptionPayment,
  handleGetTransactions,
  handleCreateTransaction,
  handleDeleteTransaction,
  handleTelegramConfirmLink,
  handleGetTelegramStatus,
  handleTelegramUnlink,
  handleUpdateProfile,
  handleChangeUsername,
  handleUploadAvatar,
  handleDeleteAvatar,
  handleGetAvatar,
  handleChangePassword,
  handleSetPassword,
  handleForgotPassword,
  handleResetPassword,
  handleExportData,
  handleDeleteAccount,
  handleRequestEmailChange,
  handleConfirmEmailChange,
  handleListTokens,
  handleCreateToken,
  handleRevokeToken,
  handleListMcpConnections,
  handleRevokeMcpConnection,
  handleMfaStatus,
  handleMfaEnableStart,
  handleMfaEnableConfirm,
  handleMfaDisable,
  handleMfaRegenerateBackup,
  handleAdminListUsers,
  handleAdminGetUser,
  handleAdminResetPassword,
  handleAdminSetRole,
  handleAdminResetUsernameCooldown,
  handleAdminListDeleted,
  handleAdminRestoreUser,
  handleAdminListTxSessions,
  handleAdminPreviewRollback,
  handleAdminRollback,
  handleDashboardPage,
  handleAdminSetSubscription
};
