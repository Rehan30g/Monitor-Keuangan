import './lib/env.js';
import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import url from 'url';
import os from 'os';
import {
  handleRegister,
  handleVerifyEmail,
  handleResendCode,
  handleLogin,
  handleLoginMfa,
  handleGoogleAuthStart,
  handleGoogleCallback,
  handleGoogleCompleteSignup,
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
  handleLogout,
  handleAdminSetSubscription
} from './lib/handlers.js';
import { sendJson, parseJsonBody } from './lib/http-utils.js';
import { isGoogleConfigured } from './lib/google-oauth.js';
import { accounts } from './lib/accounts-client.js';
import { purgeLocalUserData } from './lib/admin.js';
import db from './lib/db.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, 'public');

const PORT = 3005;
const HOST = '127.0.0.1'; // MUST listen on localhost only for secure proxy config

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8'
};

// Route auth POST harus izin method POST; sisanya tetap GET/HEAD saja.
const AUTH_POST_ROUTES = new Set([
  '/api/register',
  '/api/verify-email',
  '/api/resend-code',
  '/api/login',
  '/api/login/mfa',
  '/api/auth/google/complete-signup',
  '/api/logout',
  '/api/transactions',
  '/api/transactions/delete',
  '/api/telegram/confirm-link',
  '/api/telegram/unlink',
  '/api/profile',
  '/api/profile/username',
  '/api/profile/avatar',
  '/api/profile/avatar/delete',
  '/api/profile/password',
  '/api/profile/set-password',
  '/api/forgot-password',
  '/api/reset-password',
  '/api/profile/export',
  '/api/profile/delete',
  '/api/profile/email/request',
  '/api/profile/email/confirm',
  '/api/tokens',
  '/api/mfa/enable/start',
  '/api/mfa/enable/confirm',
  '/api/mfa/disable',
  '/api/mfa/backup-codes',
  '/api/subscription/verify-payment'
]);

// /api/tokens/<id>/revoke — id dinamis, tak bisa masuk Set exact-match di atas.
const REVOKE_TOKEN_RE = /^\/api\/tokens\/[^/]+\/revoke$/;
// /api/mcp/connections/<clientId>/revoke — sama, id dinamis.
const REVOKE_MCP_CONNECTION_RE = /^\/api\/mcp\/connections\/[^/]+\/revoke$/;
// Panel admin: segmen :userId dinamis.
const ADMIN_USER_RE = /^\/api\/admin\/users\/([^/]+)$/;
const ADMIN_RESET_PW_RE = /^\/api\/admin\/users\/([^/]+)\/reset-password$/;
const ADMIN_SET_ROLE_RE = /^\/api\/admin\/users\/([^/]+)\/role$/;
const ADMIN_RESET_USERNAME_CD_RE = /^\/api\/admin\/users\/([^/]+)\/reset-username-cooldown$/;
const ADMIN_RESTORE_RE = /^\/api\/admin\/users\/([^/]+)\/restore$/;
const ADMIN_TX_SESSIONS_RE = /^\/api\/admin\/users\/([^/]+)\/tx-sessions$/;
const ADMIN_TX_ROLLBACK_PREVIEW_RE = /^\/api\/admin\/users\/([^/]+)\/tx-rollback\/preview$/;
const ADMIN_TX_ROLLBACK_RE = /^\/api\/admin\/users\/([^/]+)\/tx-rollback$/;
const ADMIN_SET_SUBSCRIPTION_RE = /^\/api\/admin\/users\/([^/]+)\/subscription$/;

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  const isAllowedMethod =
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    (req.method === 'POST' && (AUTH_POST_ROUTES.has(pathname) || REVOKE_TOKEN_RE.test(pathname) || REVOKE_MCP_CONNECTION_RE.test(pathname) || ADMIN_RESET_PW_RE.test(pathname) || ADMIN_SET_ROLE_RE.test(pathname) || ADMIN_RESET_USERNAME_CD_RE.test(pathname) || ADMIN_RESTORE_RE.test(pathname) || ADMIN_TX_ROLLBACK_PREVIEW_RE.test(pathname) || ADMIN_TX_ROLLBACK_RE.test(pathname) || ADMIN_SET_SUBSCRIPTION_RE.test(pathname)));

  if (!isAllowedMethod) {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Set default security headers for all responses
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com");

  // Handle status API
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    const statusData = {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      runtime: `Node.js ${process.version}`,
      uptime: Math.floor(process.uptime()),
      time: new Date().toISOString()
    };
    res.end(JSON.stringify(statusData));
    return;
  }

  // Konfigurasi publik untuk frontend (site key Turnstile aman untuk diekspos)
  if (pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '',
      telegramBotUrl: process.env.TELEGRAM_BOT_USERNAME
        ? `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}`
        : '',
      googleEnabled: isGoogleConfigured()
    });
  }

  // Handle auth API
  if (pathname === '/api/register' && req.method === 'POST') {
    return handleRegister(req, res);
  }
  if (pathname === '/api/verify-email' && req.method === 'POST') {
    return handleVerifyEmail(req, res);
  }
  if (pathname === '/api/resend-code' && req.method === 'POST') {
    return handleResendCode(req, res);
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    return handleLogin(req, res);
  }
  if (pathname === '/api/login/mfa' && req.method === 'POST') {
    return handleLoginMfa(req, res);
  }
  // "Masuk dengan Google" (OAuth 2.0). Keduanya GET — lolos filter method GET.
  // Tidak butuh location nginx baru: /api/* jatuh ke `location /` -> port 3005.
  if (pathname === '/api/auth/google' && req.method === 'GET') {
    return handleGoogleAuthStart(req, res);
  }
  if (pathname === '/api/auth/google/callback' && req.method === 'GET') {
    return handleGoogleCallback(req, res);
  }
  if (pathname === '/api/auth/google/complete-signup' && req.method === 'POST') {
    return handleGoogleCompleteSignup(req, res);
  }
  if (pathname === '/api/logout' && req.method === 'POST') {
    return handleLogout(req, res);
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    return handleMe(req, res);
  }
  if (pathname === '/api/subscription/verify-payment' && req.method === 'POST') {
    return handleVerifySubscriptionPayment(req, res);
  }
  if (pathname === '/api/transactions' && req.method === 'GET') {
    return handleGetTransactions(req, res);
  }
  if (pathname === '/api/transactions' && req.method === 'POST') {
    return handleCreateTransaction(req, res);
  }
  if (pathname === '/api/transactions/delete' && req.method === 'POST') {
    return handleDeleteTransaction(req, res);
  }
  if (pathname === '/api/telegram/confirm-link' && req.method === 'POST') {
    return handleTelegramConfirmLink(req, res);
  }
  if (pathname === '/api/telegram/status' && req.method === 'GET') {
    return handleGetTelegramStatus(req, res);
  }
  if (pathname === '/api/telegram/unlink' && req.method === 'POST') {
    return handleTelegramUnlink(req, res);
  }
  if (pathname === '/api/profile' && req.method === 'POST') {
    return handleUpdateProfile(req, res);
  }
  if (pathname === '/api/profile/username' && req.method === 'POST') {
    return handleChangeUsername(req, res);
  }
  if (pathname === '/api/profile/avatar' && req.method === 'POST') {
    return handleUploadAvatar(req, res);
  }
  if (pathname === '/api/profile/avatar/delete' && req.method === 'POST') {
    return handleDeleteAvatar(req, res);
  }
  if (pathname === '/api/profile/password' && req.method === 'POST') {
    return handleChangePassword(req, res);
  }
  if (pathname === '/api/profile/set-password' && req.method === 'POST') {
    return handleSetPassword(req, res);
  }
  if (pathname === '/api/forgot-password' && req.method === 'POST') {
    return handleForgotPassword(req, res);
  }
  if (pathname === '/api/reset-password' && req.method === 'POST') {
    return handleResetPassword(req, res);
  }
  if (pathname === '/api/profile/export' && req.method === 'POST') {
    return handleExportData(req, res);
  }
  if (pathname === '/api/profile/delete' && req.method === 'POST') {
    return handleDeleteAccount(req, res);
  }
  if (pathname === '/api/profile/email/request' && req.method === 'POST') {
    return handleRequestEmailChange(req, res);
  }
  if (pathname === '/api/profile/email/confirm' && req.method === 'POST') {
    return handleConfirmEmailChange(req, res);
  }
  if (pathname === '/api/tokens' && req.method === 'GET') {
    return handleListTokens(req, res);
  }
  if (pathname === '/api/tokens' && req.method === 'POST') {
    return handleCreateToken(req, res);
  }
  if (req.method === 'POST' && REVOKE_TOKEN_RE.test(pathname)) {
    const tokenId = pathname.split('/')[3];
    return handleRevokeToken(req, res, tokenId);
  }
  if (pathname === '/api/mcp/connections' && req.method === 'GET') {
    return handleListMcpConnections(req, res);
  }
  if (req.method === 'POST' && REVOKE_MCP_CONNECTION_RE.test(pathname)) {
    const clientId = pathname.split('/')[4];
    return handleRevokeMcpConnection(req, res, clientId);
  }
  if (pathname === '/api/mfa/status' && req.method === 'GET') {
    return handleMfaStatus(req, res);
  }
  if (pathname === '/api/mfa/enable/start' && req.method === 'POST') {
    return handleMfaEnableStart(req, res);
  }
  if (pathname === '/api/mfa/enable/confirm' && req.method === 'POST') {
    return handleMfaEnableConfirm(req, res);
  }
  if (pathname === '/api/mfa/disable' && req.method === 'POST') {
    return handleMfaDisable(req, res);
  }
  if (pathname === '/api/mfa/backup-codes' && req.method === 'POST') {
    return handleMfaRegenerateBackup(req, res);
  }
  if (pathname === '/api/admin/users' && req.method === 'GET') {
    return handleAdminListUsers(req, res);
  }
  if (pathname === '/api/admin/deleted-users' && req.method === 'GET') {
    return handleAdminListDeleted(req, res);
  }
  if (req.method === 'POST' && ADMIN_RESTORE_RE.test(pathname)) {
    return handleAdminRestoreUser(req, res, pathname.match(ADMIN_RESTORE_RE)[1]);
  }
  if (req.method === 'POST' && ADMIN_RESET_PW_RE.test(pathname)) {
    return handleAdminResetPassword(req, res, pathname.match(ADMIN_RESET_PW_RE)[1]);
  }
  if (req.method === 'POST' && ADMIN_SET_ROLE_RE.test(pathname)) {
    return handleAdminSetRole(req, res, pathname.match(ADMIN_SET_ROLE_RE)[1]);
  }
  if (req.method === 'POST' && ADMIN_SET_SUBSCRIPTION_RE.test(pathname)) {
    return handleAdminSetSubscription(req, res, pathname.match(ADMIN_SET_SUBSCRIPTION_RE)[1]);
  }
  if (req.method === 'POST' && ADMIN_RESET_USERNAME_CD_RE.test(pathname)) {
    return handleAdminResetUsernameCooldown(req, res, pathname.match(ADMIN_RESET_USERNAME_CD_RE)[1]);
  }
  if (req.method === 'GET' && ADMIN_TX_SESSIONS_RE.test(pathname)) {
    return handleAdminListTxSessions(req, res, pathname.match(ADMIN_TX_SESSIONS_RE)[1]);
  }
  if (req.method === 'POST' && ADMIN_TX_ROLLBACK_PREVIEW_RE.test(pathname)) {
    return handleAdminPreviewRollback(req, res, pathname.match(ADMIN_TX_ROLLBACK_PREVIEW_RE)[1]);
  }
  if (req.method === 'POST' && ADMIN_TX_ROLLBACK_RE.test(pathname)) {
    return handleAdminRollback(req, res, pathname.match(ADMIN_TX_ROLLBACK_RE)[1]);
  }
  if (req.method === 'GET' && ADMIN_USER_RE.test(pathname)) {
    return handleAdminGetUser(req, res, pathname.match(ADMIN_USER_RE)[1]);
  }
  if (pathname.startsWith('/api/avatar/') && req.method === 'GET') {
    const userId = pathname.slice('/api/avatar/'.length);
    return handleGetAvatar(req, res, userId);
  }
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Not Found' });
  }

  // Dashboard dirender per-request (bukan file statis) supaya tautan panel
  // admin bisa dihapus sepenuhnya dari HTML untuk user biasa, bukan cuma
  // disembunyikan lewat CSS/JS.
  if ((pathname === '/dashboard' || pathname === '/dashboard.html') && req.method === 'GET') {
    return handleDashboardPage(req, res);
  }

  // Redirect root path to index.html
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  // Dukung clean URL: /login -> /login.html, dsb (hanya jika tak ada ekstensi)
  if (path.extname(pathname) === '') {
    pathname = `${pathname}.html`;
  }

  // Resolve path to prevent directory traversal attacks
  const targetFilePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  // Security boundary check: ensure resolved path starts with the public directory path
  if (!targetFilePath.startsWith(PUBLIC_DIR + path.sep) && targetFilePath !== PUBLIC_DIR) {
    // TODO(security): Strict directory bounds validation
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  try {
    const fileHandle = await fs.open(targetFilePath, 'r');
    const stats = await fileHandle.stat();

    // Check if it's a directory (if so, return 404/403 or try to serve index.html inside)
    if (stats.isDirectory()) {
      await fileHandle.close();
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(targetFilePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stats.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
    });

    // Read and pipe stream
    const data = await fs.readFile(targetFilePath);
    await fileHandle.close();
    res.end(data);

  } catch (err) {
    // Check if file doesn't exist
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    } else {
      console.error('Server error handling request:', err.message);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`🌐 Server running securely on http://${HOST}:${PORT}`);
});

// Sweep akun soft-deleted 7-hari sekarang dijalankan oleh accounts service
// sendiri (lihat /root/accounts/server.js) — service itu yang memiliki tabel
// users/deletedAt. Saat accounts service benar-benar purge sebuah akun
// permanen, ia memanggil balik POST /internal/hooks/user-purged (didaftarkan
// terpisah di bawah, bukan lewat router utama karena tidak melalui proxy
// nginx/browser) supaya UangKu bisa membersihkan data lokalnya sendiri —
// pengganti purgeUserAccount versi lama yang dulu satu proses.
const INTERNAL_HOOK_KEY = process.env.INTERNAL_API_KEY || '';
const hookServer = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/internal/hooks/user-purged') {
    return sendJson(res, 404, { error: 'not_found' });
  }
  if (req.headers['x-internal-key'] !== INTERNAL_HOOK_KEY) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  let body;
  try {
    body = await parseJsonBody(req, 4096);
  } catch {
    return sendJson(res, 400, { error: 'invalid_body' });
  }
  if (body.userId) {
    try {
      purgeLocalUserData(body.userId);
    } catch (err) {
      console.error('Gagal membersihkan data lokal untuk akun yang dipurge:', err.message);
    }
  }
  sendJson(res, 200, { ok: true });
});
// Port terpisah, 127.0.0.1-only — dipanggil server-to-server oleh accounts
// service, tidak pernah lewat nginx/browser (beda port dari PORT utama biar
// tidak menambah kompleksitas routing whitelist server.js yang sudah ada).
const HOOK_PORT = 4006;
hookServer.listen(HOOK_PORT, '127.0.0.1', () => {
  console.log(`🔗 Purge webhook listener aktif di 127.0.0.1:${HOOK_PORT}`);
});

// Bootstrap admin: promosikan username di ADMIN_USERNAMES (dipisah koma) jadi
// role='admin' di users_local setiap startup. Idempoten & self-healing (hanya
// promosi, tak pernah demosi otomatis). Dulu di db.js (query lokal langsung);
// sekarang perlu lookup username->id ke accounts service dulu, jadi async.
async function bootstrapAdmins() {
  const raw = process.env.ADMIN_USERNAMES || '';
  const usernames = raw.split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  for (const username of usernames) {
    try {
      const r = await accounts.get(`/internal/users/by-username/${encodeURIComponent(username)}`);
      if (r.status !== 200) continue;
      db.prepare(`INSERT OR IGNORE INTO users_local (id, role, subscription) VALUES (?, 'user', 'free')`).run(r.body.id);
      db.prepare(`UPDATE users_local SET role = 'admin' WHERE id = ? AND role != 'admin'`).run(r.body.id);
    } catch (err) {
      console.error(`Bootstrap admin gagal untuk ${username}:`, err.message);
    }
  }
}
bootstrapAdmins();
