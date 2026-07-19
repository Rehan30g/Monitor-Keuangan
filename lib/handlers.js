import {
  hashPassword,
  verifyPassword,
  DUMMY_HASH,
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserById,
  createGoogleUserWithUsername,
  updateUsername,
  updateUserSubscription,
  createPendingGoogleSignup,
  getPendingGoogleSignup,
  consumePendingGoogleSignup,
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
import { extForMime, MIME_TO_EXT, saveAvatar, removeAvatar, readAvatar } from './avatars.js';
import { createApiToken, listApiTokens, revokeApiToken } from './api-tokens.js';
import { listConnectedClients, revokeClientForUser } from './oauth-store.js';
import { parseJsonBody, parseCookies, sendJson, getClientIp, createRateLimiter } from './http-utils.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sendVerificationEmail,
  sendLoginAlertEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendPasswordSetEmail,
  sendDataExportEmail,
  sendAccountDeletedEmail,
  sendEmailChangeVerification,
  sendEmailChangedNotice,
  sendMfaEnabledEmail,
  sendMfaDisabledEmail
} from './email.js';
import { verifyCaptcha } from './captcha.js';
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
import {
  isGoogleConfigured,
  createState,
  consumeState,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  normalizeProfile,
  resolveGoogleLogin
} from './google-oauth.js';
import { verifySubscriptionPayment } from './openrouter.js';

const registerLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });
const loginLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });
const resendLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 3 });
const codeVerifyLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

const SESSION_COOKIE = 'sid';
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

  if (!user || user.deletedAt) {
    // Akun tidak ada ATAU sudah soft-deleted: perlakukan identik supaya status
    // penghapusan tidak bocor. Tetap lakukan verifikasi dummy agar waktu respons
    // konsisten (anti-enumeration).
    verifyPassword(password, DUMMY_HASH);
    return sendJson(res, 401, genericError);
  }

  if (isLocked(user)) {
    recordLoginHistory({
      userId: user.id,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
      success: false
    });
    return sendJson(res, 429, { error: 'Akun terkunci sementara. Coba lagi nanti.' });
  }

  const valid = verifyPassword(password, user.passwordHash);
  if (!valid) {
    registerFailedLogin(user);
    recordLoginHistory({
      userId: user.id,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || null,
      success: false
    });
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

  // MFA aktif: JANGAN terbitkan sesi dulu. Buat challenge singkat & minta kode
  // di langkah kedua (tanpa Set-Cookie). Sesi baru dibuat di handleLoginMfa.
  if (isMfaEnabled(user.id)) {
    const challenge = createLoginChallenge(user.id);
    return sendJson(res, 200, { mfaRequired: true, challengeId: challenge.id });
  }

  return issueSessionAndRespond(req, res, user);
}

// Terbitkan sesi + Set-Cookie, kirim notifikasi login, balas sukses. Dipakai
// oleh handleLogin (tanpa MFA) dan handleLoginMfa (setelah kode terverifikasi)
// supaya perilaku keduanya identik.
// Efek samping terbitnya sesi: Set-Cookie, catat login_history (visibilitas
// admin — berlaku untuk akun Google juga), kirim notifikasi login. TIDAK
// mengakhiri respons; pemanggil yang memutuskan JSON (login normal) atau
// redirect (alur Google). Tak pernah menulis password_change_log.
function establishSession(req, res, user) {
  const session = createSession(user.id);
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', sessionCookieHeader(session.id, maxAgeSeconds));

  // Sesi sungguhan terbit = login berhasil (jalur tanpa-MFA maupun setelah MFA).
  recordLoginHistory({
    userId: user.id,
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || null,
    success: true
  });

  sendLoginAlertEmail(user.email, {
    username: user.username,
    time: new Date().toLocaleString('id-ID', { dateStyle: 'full', timeStyle: 'medium' }),
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || 'Tidak diketahui'
  }).catch((err) => console.error('Gagal mengirim notifikasi login:', err.message));
}

function issueSessionAndRespond(req, res, user) {
  establishSession(req, res, user);
  return sendJson(res, 200, { message: 'Login berhasil.', username: user.username });
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

  const user = findUserById(challenge.userId);
  if (!user) {
    return sendJson(res, 400, GENERIC_CODE_ERROR);
  }

  return issueSessionAndRespond(req, res, user);
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

// Timeout untuk fetch foto profil Google — jangan biarkan request menggantung
// memblokir respons login.
const GOOGLE_AVATAR_FETCH_TIMEOUT_MS = 5000;

// Impor foto profil Google (URL dari userinfo) menjadi avatar akun. STRICTLY
// best-effort: tidak pernah throw, selalu resolve; kegagalan apa pun (jaringan,
// host salah, content-type salah, kebesaran) dilewati diam-diam agar login tak
// pernah terganggu. Pemanggil bertanggung jawab memastikan akun BELUM punya
// avatar (avatarExt null) sebelum memanggil ini.
//
// Pertahanan (defense-in-depth / anti-SSRF bila kode ini dipakai ulang):
//  - hanya https ke host *.googleusercontent.com (CDN foto Google), tolak lain;
//  - tolak redirect (redirect: 'error') supaya tak dibelokkan ke host internal;
//  - timeout via AbortController (~5s);
//  - batas ukuran = MAX_AVATAR_BYTES (sama seperti upload manual), dicek dari
//    Content-Length (bila ada) DAN saat streaming (abort bila terlampaui);
//  - Content-Type harus salah satu tipe gambar yang diterima (MIME_TO_EXT).
async function importGoogleAvatar(userId, pictureUrl) {
  try {
    if (!pictureUrl || typeof pictureUrl !== 'string') return false;

    let parsed;
    try {
      parsed = new URL(pictureUrl);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'googleusercontent.com' && !host.endsWith('.googleusercontent.com')) {
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_AVATAR_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(pictureUrl, {
        signal: controller.signal,
        redirect: 'error'
      });
      if (!resp || !resp.ok || !resp.body) return false;

      // Content-Type harus tipe gambar yang kita terima.
      const ct = String(resp.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      const ext = extForMime(ct);
      if (!ext || !MIME_TO_EXT[ct]) return false;

      // Content-Length (bila ada) di atas batas → langsung tolak.
      const declaredLen = Number(resp.headers.get('content-length'));
      if (Number.isFinite(declaredLen) && declaredLen > MAX_AVATAR_BYTES) {
        return false;
      }

      // Baca body sebagai stream berbatas — abort bila melampaui batas.
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.length;
        if (total > MAX_AVATAR_BYTES) {
          await reader.cancel().catch(() => {});
          return false;
        }
        chunks.push(value);
      }
      if (total === 0) return false;

      const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
      saveAvatar(userId, buffer, ext);
      updateAvatarExt(userId, ext);
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Best-effort: telan semua error, hanya catat untuk debugging.
    console.log('Google avatar import skipped:', err && err.message);
    return false;
  }
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

  let profile;
  try {
    const tokens = await exchangeCodeForTokens(String(code));
    const info = await fetchUserInfo(tokens.access_token);
    profile = normalizeProfile(info);
  } catch (err) {
    console.error('Google OAuth callback error:', err.message);
    return redirectToLoginError(res, 'google_failed');
  }

  const result = resolveGoogleLogin(profile);
  if (result.error) {
    return redirectToLoginError(res, result.error);
  }

  // Akun baru: JANGAN buat langsung. Simpan profil pending (single-use, TTL)
  // & arahkan user memilih username sendiri di /google-username.
  if (result.newSignup) {
    const { token } = createPendingGoogleSignup(result.newSignup);
    res.setHeader('Set-Cookie', GOOGLE_STATE_CLEAR);
    res.writeHead(302, { Location: `/google-username?token=${encodeURIComponent(token)}` });
    return res.end();
  }

  const user = result.user;

  // Hormati MFA: akun tertaut yang mengaktifkan MFA tetap harus tantangan kode.
  // Buat challenge & arahkan ke /login yang membuka sheet MFA (POST /api/login/mfa).
  if (isMfaEnabled(user.id)) {
    const challenge = createLoginChallenge(user.id);
    res.setHeader('Set-Cookie', GOOGLE_STATE_CLEAR);
    res.writeHead(302, { Location: `/login?mfaChallenge=${encodeURIComponent(challenge.id)}` });
    return res.end();
  }

  // Tanpa MFA: terbitkan sesi (jalur yang sama dengan login normal) & ke dashboard.
  establishSession(req, res, user);
  // Auto-impor foto Google jadi avatar HANYA bila akun belum punya avatar.
  // Best-effort & inline (app ini tanpa job queue); kegagalan tak boleh
  // mengganggu login (importGoogleAvatar tak pernah throw).
  if (!user.avatarExt) {
    await importGoogleAvatar(user.id, profile.picture);
  }
  res.writeHead(302, { Location: '/dashboard' });
  return res.end();
}

// Selesaikan pendaftaran Google: user memilih username, lalu akun dibuat.
// Validasi token pending (ada, belum kedaluwarsa, belum dipakai) + username
// (validateUsername + keunikan, sama seperti register), buat akun dengan
// username pilihan, konsumsi token, terbitkan sesi (jalur yang sama dengan
// login Google langsung), balas redirect ke dashboard.
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

  const token = String(body.token || '');
  const username = normalizeUsername(body.username || '');

  const pending = getPendingGoogleSignup(token);
  if (!pending) {
    return sendJson(res, 400, { error: 'Sesi pendaftaran tidak valid atau sudah kedaluwarsa. Silakan ulangi login dengan Google.' });
  }

  if (!validateUsername(username)) {
    return sendJson(res, 400, {
      error: 'Username harus 3-32 karakter, hanya huruf/angka/underscore.'
    });
  }
  if (findUserByUsername(username)) {
    return sendJson(res, 409, { error: 'Username sudah digunakan.' });
  }

  // Balapan tipis (email/googleId keburu jadi akun via jalur lain) ditangkap
  // oleh UNIQUE constraint — perlakukan sebagai konflik yang bisa diulang.
  let user;
  try {
    user = createGoogleUserWithUsername({
      email: pending.email,
      googleId: pending.googleId,
      displayName: pending.displayName,
      username
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return sendJson(res, 409, { error: 'Username sudah digunakan.' });
    }
    console.error('Google complete-signup error:', err.message);
    return sendJson(res, 500, { error: 'Terjadi kesalahan pada server.' });
  }

  consumePendingGoogleSignup(token);

  // Auto-impor foto Google (yang ikut disimpan di baris pending) jadi avatar.
  // Akun baru dibuat → avatarExt pasti null, tapi tetap dijaga konsisten.
  // Best-effort; tak pernah throw / mengganggu pembuatan akun.
  if (pending.picture && !user.avatarExt) {
    await importGoogleAvatar(user.id, pending.picture);
  }

  // Akun baru — tak mungkin punya MFA. Terbitkan sesi persis seperti login
  // Google langsung (Set-Cookie + login_history + notifikasi login).
  establishSession(req, res, user);
  return sendJson(res, 200, { message: 'Akun berhasil dibuat.', redirect: '/dashboard' });
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
    avatarUrl: user.avatarExt ? `/api/avatar/${user.id}` : null,
    role: user.role || 'user',
    usernameChangedAt: user.usernameChangedAt || null,
    subscription: user.subscription || 'free',
    hasPassword: !!user.passwordHash
  });
}

const USERNAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari antar perubahan

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
const PAYMENT_IMAGE_LIMIT = 8 * 1024 * 1024; // 8 MB — cukup untuk foto kamera full-res base64
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

// Ganti username sendiri, dibatasi sekali per 7 hari (cooldown). Admin bisa
// mereset cooldown lewat panel. Mengikuti pola auth+rate-limit+validasi
// handleUpdateProfile/handleChangePassword. usernameChangedAt NULL = belum
// pernah ganti → tak ada cooldown.
async function handleChangeUsername(req, res) {
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

  const newUsername = normalizeUsername(body.newUsername || '');

  if (!validateUsername(newUsername)) {
    return sendJson(res, 400, {
      error: 'Username harus 3-32 karakter, hanya huruf/angka/underscore.'
    });
  }
  if (newUsername === user.username) {
    return sendJson(res, 400, { error: 'Username baru sama dengan username saat ini.' });
  }

  // Cooldown 7 hari sejak perubahan terakhir (NULL = belum pernah → lolos).
  if (user.usernameChangedAt && Date.now() - user.usernameChangedAt < USERNAME_COOLDOWN_MS) {
    const nextAllowedAt = user.usernameChangedAt + USERNAME_COOLDOWN_MS;
    return sendJson(res, 429, { error: 'username_cooldown', nextAllowedAt });
  }

  // Keunikan case-insensitive (username disimpan sudah dinormalisasi lowercase).
  if (findUserByUsername(newUsername)) {
    return sendJson(res, 409, { error: 'Username sudah digunakan.' });
  }

  try {
    updateUsername(user.id, newUsername);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return sendJson(res, 409, { error: 'Username sudah digunakan.' });
    }
    console.error('Change username error:', err.message);
    return sendJson(res, 500, { error: 'Terjadi kesalahan pada server.' });
  }

  return sendJson(res, 200, { message: 'Username berhasil diubah.', username: newUsername });
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
const resetPasswordSubmitLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 10 });

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

// Link darurat "bukan saya" untuk flow set-password berumur panjang (14 hari),
// bukan 30 menit seperti reset biasa: akun Google-only mungkin jarang membuka
// email, dan link ini adalah satu-satunya jalan pulih bila password disetel penyerang.
const SET_PASSWORD_REVERT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 hari

// Untuk akun TANPA password (mis. akun Google, passwordHash NULL): setel password
// pertama. TIDAK boleh menimpa password yang sudah ada — itu ranah handleChangePassword
// yang mewajibkan verifikasi password lama. Otorisasi di sini adalah sesi login yang aktif.
async function handleSetPassword(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (passwordLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  // Cek load-bearing: hanya untuk akun yang BELUM punya password. Mencegah endpoint
  // ini jadi jalan pintas melewati pemeriksaan password lama di handleChangePassword.
  if (user.passwordHash) {
    return sendJson(res, 400, {
      error: 'Akun ini sudah punya password. Gunakan menu Ganti password.'
    });
  }

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const newPassword = String(body.newPassword || '');
  if (!validatePassword(newPassword)) {
    return sendJson(res, 400, { error: 'Password baru minimal 8 karakter.' });
  }

  updatePassword(user.id, newPassword, 'self');

  // Sengaja TIDAK men-destroy sesi lain: ini penambahan password pertama pada akun
  // Google-only, bukan pemulihan dari kompromi — sesi login yang ada tetap valid.

  // Kirim notifikasi dengan link darurat "bukan saya" berumur 14 hari yang tidak
  // butuh password lama. Fire-and-forget, jangan gagalkan respons bila email gagal.
  const { token } = createPasswordResetToken(user.id, SET_PASSWORD_REVERT_TTL_MS);
  const revertLink = `${process.env.PUBLIC_BASE_URL || 'https://huzky.xyz'}/reset-password?token=${token}`;
  sendPasswordSetEmail(user.email, revertLink).catch((err) =>
    console.error('Gagal mengirim notifikasi set password:', err.message)
  );

  return sendJson(res, 200, { message: 'Password berhasil dibuat.' });
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

async function handleListMcpConnections(req, res) {
  const user = getAuthUser(req);
  if (!user) {
    return sendJson(res, 401, { error: 'Belum login.' });
  }
  if (tokenLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }

  return sendJson(res, 200, { connections: listConnectedClients(user.id) });
}

async function handleRevokeMcpConnection(req, res, clientId) {
  const user = getAuthUser(req);
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
  const user = getAuthUser(req);
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
  const user = getAuthUser(req);
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
  if (!verifyPassword(currentPassword, user.passwordHash)) {
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
  const user = getAuthUser(req);
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

  if (!verifyPassword(currentPassword, user.passwordHash)) {
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
  const user = getAuthUser(req);
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
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return sendJson(res, 400, { error: 'Password saat ini salah.' });
  }
  if (!isMfaEnabled(user.id)) {
    return sendJson(res, 409, { error: 'Verifikasi dua langkah belum aktif.' });
  }

  const backupCodes = regenerateBackupCodes(user.id);
  return sendJson(res, 200, { backupCodes });
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
  // Lewati akun soft-deleted: jangan kirim reset ke alamatnya, tapi tetap balas
  // pesan generik yang sama supaya status penghapusan tidak bocor. Akun Google
  // (passwordHash NULL) tidak punya password untuk direset — juga dilewati.
  if (user && !user.deletedAt && user.passwordHash) {
    const { token } = createPasswordResetToken(user.id);
    const resetLink = `${process.env.PUBLIC_BASE_URL || 'https://huzky.xyz'}/reset-password?token=${token}`;
    sendPasswordResetEmail(user.email, resetLink).catch((err) =>
      console.error('Gagal mengirim email reset password:', err.message)
    );
  }

  return sendJson(res, 200, genericMessage);
}

async function handleResetPassword(req, res) {
  if (resetPasswordSubmitLimiter(getClientIp(req))) {
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
  updatePassword(entry.userId, newPassword, 'reset');
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
  // Soft-delete: avatar & data lain sengaja DIBIARKAN agar akun bisa dipulihkan
  // utuh dalam 7 hari. Pembersihan permanen (termasuk avatar) baru terjadi di
  // purgeUserAccount saat sweep masa tenggang.
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

const subscriptionVerifyLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

async function handleVerifySubscriptionPayment(req, res) {
  const user = getAuthUser(req);
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

  const sessionId = parseCookies(req)[SESSION_COOKIE] || null;
  const result = addTransaction(user.id, jenis, keterangan, cleanedJumlah, { sessionLabel: sessionId });
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

  const sessionId = parseCookies(req)[SESSION_COOKIE] || null;
  const result = deleteTransaction(user.id, id, { sessionLabel: sessionId });
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

// ---------------------------------------------------------------------------
// Panel admin
// ---------------------------------------------------------------------------
const adminLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 20 });

// Gerbang akses admin. Mengembalikan { user } jika lolos, atau kode alasan
// yang membedakan "belum login" / "bukan admin" / "wajib 2FA" supaya klien
// bisa memilih status HTTP & pesan yang tepat.
function requireAdmin(req) {
  const user = getAuthUser(req);
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
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  return sendJson(res, 200, { users: listUsers() });
}

async function handleAdminGetUser(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const detail = getUserDetail(targetUserId);
  if (!detail) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }
  return sendJson(res, 200, { user: detail });
}

// Admin memicu reset password: pakai persis alur self-service (forgot-password).
// Admin tak pernah menetapkan/melihat password — hanya menyebabkan email reset
// yang sama seperti yang bisa dipicu user sendiri. Token TIDAK dikembalikan.
async function handleAdminResetPassword(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = findUserById(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  const { token } = createPasswordResetToken(target.id);
  const resetLink = `${process.env.PUBLIC_BASE_URL || 'https://huzky.xyz'}/reset-password?token=${token}`;
  sendPasswordResetEmail(target.email, resetLink).catch((err) =>
    console.error('Gagal mengirim email reset password (admin):', err.message)
  );

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
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  let body;
  try {
    body = await parseJsonBody(req);
  } catch (err) {
    return sendJson(res, err.statusCode || 400, { error: 'Permintaan tidak valid.' });
  }

  const newRole = String(body.role || '');
  const target = findUserById(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }
  const oldRole = target.role || 'user';

  const result = setUserRole(targetUserId, newRole);
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
  const gate = requireAdmin(req);
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

  const target = findUserById(targetUserId);
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

  const updatedTarget = findUserById(targetUserId);
  return sendJson(res, 200, { ok: true, user: updatedTarget });
}

// Daftar akun soft-deleted yang masih dalam masa tenggang 7 hari, lengkap
// dengan daysRemaining untuk ditampilkan di panel admin.
async function handleAdminListDeleted(req, res) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  return sendJson(res, 200, { accounts: listDeletedAccounts() });
}

// Pulihkan akun soft-deleted (batalkan deletedAt). Tidak menyentuh data lain.
async function handleAdminRestoreUser(req, res, targetUserId) {
  if (adminLimiter(getClientIp(req))) {
    return sendJson(res, 429, { error: 'Terlalu banyak permintaan. Coba lagi nanti.' });
  }
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = findUserById(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  const result = restoreUserAccount(targetUserId);
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
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = findUserById(targetUserId);
  if (!target) {
    return sendJson(res, 404, { error: 'Pengguna tidak ditemukan.' });
  }

  const result = resetUsernameCooldown(targetUserId);
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
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = findUserById(targetUserId);
  if (!target) {
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
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = findUserById(targetUserId);
  if (!target) {
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
  const gate = requireAdmin(req);
  if (denyIfNotAdmin(res, gate)) return;

  const target = findUserById(targetUserId);
  if (!target) {
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
  const user = getAuthUser(req);
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
  importGoogleAvatar,
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
