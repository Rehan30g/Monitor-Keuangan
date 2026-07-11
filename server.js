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
  handleLogout,
  handleMe,
  handleGetTransactions,
  handleCreateTransaction,
  handleDeleteTransaction,
  handleTelegramConfirmLink
} from './lib/handlers.js';
import { sendJson } from './lib/http-utils.js';

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
  '.ico': 'image/x-icon'
};

// Route auth POST harus izin method POST; sisanya tetap GET/HEAD saja.
const AUTH_POST_ROUTES = new Set([
  '/api/register',
  '/api/verify-email',
  '/api/resend-code',
  '/api/login',
  '/api/logout',
  '/api/transactions',
  '/api/transactions/delete',
  '/api/telegram/confirm-link'
]);

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  const isAllowedMethod =
    req.method === 'GET' ||
    req.method === 'HEAD' ||
    (req.method === 'POST' && AUTH_POST_ROUTES.has(pathname));

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
    return sendJson(res, 200, { turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || '' });
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
  if (pathname === '/api/logout' && req.method === 'POST') {
    return handleLogout(req, res);
  }
  if (pathname === '/api/me' && req.method === 'GET') {
    return handleMe(req, res);
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
  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Not Found' });
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
      'Content-Length': stats.size
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
