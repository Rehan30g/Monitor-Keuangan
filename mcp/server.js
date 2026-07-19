import '../lib/env.js';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { parseCookies } from '../lib/http-utils.js';
import { accounts } from '../lib/accounts-client.js';
import db from '../lib/db.js';
import { findApiTokenByRaw, touchApiToken } from '../lib/api-tokens.js';
import { getTransactions, addTransaction, deleteTransaction, getTransactionCountToday, checkMcpTelegramWriteLimit } from '../lib/transactions.js';
import {
  getOAuthClient,
  registerOAuthClient,
  createAuthorizationCode,
  getAuthorizationCode,
  consumeAuthorizationCode,
  issueOAuthTokens,
  findOAuthAccessToken,
  findOAuthTokenByRefresh,
  revokeOAuthTokenByRaw,
  touchOAuthAccessToken
} from '../lib/oauth-store.js';

const PORT = 3007;
const HOST = '127.0.0.1'; // sama seperti server.js utama — di belakang Nginx
const ORIGIN = 'https://huzky.xyz';
const SESSION_COOKIE = 'sid';

function getLocalSubscription(userId) {
  const row = db.prepare(`SELECT subscription FROM users_local WHERE id = ?`).get(userId);
  return (row && row.subscription) || 'free';
}

// -------------------------------------------------------------------------
// Provider OAuth 2.1 — dipakai konektor web (mis. Claude.ai) yang cuma minta
// URL server + opsional Client ID/Secret, tanpa kolom header/token manual.
// Token akses PAT statis (dibuat manual dari Pengaturan) tetap didukung
// lewat verifyAccessToken di bawah — dua jalur otentikasi berbagi satu
// endpoint /mcp.
// -------------------------------------------------------------------------

async function currentUserFromCookies(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const session = await accounts.get(`/internal/sessions/${sessionId}`);
  if (session.status !== 200) return null;
  return session.body.user;
}

// Ikon generik (robot) buat konektor yang bukan Claude — daripada nambah
// logo tiap aplikasi AI satu-satu (ChatGPT, Gemini, dst), yang belum tentu
// lengkap dan gampang basi.
const GENERIC_BOT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <rect x="4" y="8" width="16" height="12" rx="3"/>
  <path d="M12 8V4"/>
  <circle cx="12" cy="3" r="1"/>
  <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/>
  <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/>
  <path d="M4 13H2"/>
  <path d="M22 13h-2"/>
</svg>`;

// Nama aplikasi konektor yang dikenal ditampilkan dengan badge ikonnya sendiri;
// selain itu jatuh ke badge generik (robot abu-abu).
function badgeForClient(appName) {
  const lower = appName.toLowerCase();
  if (lower.includes('claude')) {
    return '<div class="claude-badge"><img src="/icons/claude.png" alt=""></div>';
  }
  return `<div class="claude-badge generic-badge">${GENERIC_BOT_SVG}</div>`;
}

function renderConsentPage({ client, params, user }) {
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const appName = escape(client.client_name || client.client_id);
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escape(value ?? '')}">`;
  const avatarUrl = user.avatarExt ? `/api/avatar/${user.id}` : '';
  const seed = escape(user.id || user.username);
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Hubungkan ke ${appName} - UangKu</title>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/style.css">
</head>
<body class="auth-body">
  <div class="auth-main">
    <div class="container">
      <div class="auth-brand">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><path d="M16 15h2"/></svg>
        UangKu
      </div>
      <h1>Hubungkan ke ${appName}</h1>
      <p class="auth-sub">Konfirmasi koneksi antara akun UangKu kamu dan ${appName}.</p>

      <div class="link-visual" id="link-visual" aria-hidden="true">
        <div class="avatar avatar-lg" id="link-avatar"></div>
        <div class="link-connector"><span></span><span></span><span></span></div>
        ${badgeForClient(client.client_name || client.client_id)}
      </div>

      <div class="link-identity">
        <span class="link-name">${escape(user.displayName || user.username)}</span>
        <span class="link-username">@${escape(user.username)}</span>
      </div>

      <p class="link-state">Aplikasi ini akan bisa membaca, menambah, dan menghapus transaksi keuanganmu.</p>

      <form method="POST" action="/authorize/decision">
        ${hidden('client_id', client.client_id)}
        ${hidden('redirect_uri', params.redirectUri)}
        ${hidden('state', params.state)}
        ${hidden('code_challenge', params.codeChallenge)}
        ${hidden('scope', (params.scopes || []).join(' '))}
        ${hidden('resource', params.resource ? params.resource.href : '')}
        <button type="submit" name="decision" value="approve" class="link-confirm">Izinkan</button>
        <button type="submit" name="decision" value="deny" class="link-deny">Tolak</button>
      </form>

      <p class="link-hint">Kamu bisa mencabut akses ini kapan saja dari Pengaturan &rarr; Koneksi &rarr; MCP.</p>
    </div>
  </div>

  <footer>
    <p>&copy; 2026 Huzky.xyz</p>
  </footer>

  <script>
    (function () {
      var el = document.getElementById('link-avatar');
      var avatarUrl = ${JSON.stringify(avatarUrl)};
      var seed = ${JSON.stringify(seed)};
      if (avatarUrl) {
        var img = document.createElement('img');
        img.src = avatarUrl + (avatarUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
        img.alt = '';
        el.appendChild(img);
        return;
      }
      var SVG_NS = 'http://www.w3.org/2000/svg';
      function svgEl(tag, attrs) {
        var node = document.createElementNS(SVG_NS, tag);
        for (var k in attrs) node.setAttribute(k, attrs[k]);
        return node;
      }
      function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
      function hashString(str) {
        var h = 0;
        for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
        return h >>> 0;
      }
      var size = 64;
      var hash = hashString(seed);
      var warna = cssVar('--avatar-' + ((hash % 8) + 1));
      var bg = cssVar('--surface-2');
      var svg = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: size, height: size, role: 'img', 'aria-label': 'Avatar' });
      svg.appendChild(svgEl('rect', { x: 0, y: 0, width: size, height: size, fill: bg }));
      var cell = size / 5;
      var bit = 8;
      for (var row = 0; row < 5; row++) {
        for (var col = 0; col < 3; col++) {
          var nyala = (hash >> bit) & 1;
          bit++;
          if (!nyala) continue;
          var kolom = col === 2 ? [2] : [col, 4 - col];
          for (var ci = 0; ci < kolom.length; ci++) {
            svg.appendChild(svgEl('rect', { x: kolom[ci] * cell, y: row * cell, width: cell, height: cell, fill: warna }));
          }
        }
      }
      el.appendChild(svg);
    })();
  </script>
</body>
</html>`;
}

const provider = {
  clientsStore: {
    async getClient(clientId) {
      const row = getOAuthClient(clientId);
      if (!row) return undefined;
      return {
        client_id: row.clientId,
        client_secret: row.clientSecret || undefined,
        client_secret_expires_at: row.clientSecretExpiresAt || undefined,
        client_name: row.clientName || undefined,
        redirect_uris: JSON.parse(row.redirectUris),
        token_endpoint_auth_method: row.clientSecret ? 'client_secret_post' : 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      };
    },
    async registerClient(clientInfo) {
      registerOAuthClient({
        clientId: clientInfo.client_id,
        clientSecret: clientInfo.client_secret,
        clientSecretExpiresAt: clientInfo.client_secret_expires_at,
        redirectUris: clientInfo.redirect_uris,
        clientName: clientInfo.client_name
      });
      return clientInfo;
    }
  },

  async authorize(client, params, res) {
    const user = await currentUserFromCookies(res.req);
    if (!user) {
      const returnTo = res.req.originalUrl;
      res.redirect(`${ORIGIN}/login?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }
    res.set('Content-Type', 'text/html');
    res.send(renderConsentPage({ client, params, user }));
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const row = getAuthorizationCode(authorizationCode);
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError('Kode otorisasi tidak valid atau sudah kedaluwarsa');
    }
    return row.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    const row = getAuthorizationCode(authorizationCode);
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError('Kode otorisasi tidak valid atau sudah kedaluwarsa');
    }
    if (redirectUri && redirectUri !== row.redirectUri) {
      throw new InvalidGrantError('redirect_uri tidak cocok dengan permintaan otorisasi awal');
    }
    consumeAuthorizationCode(authorizationCode);
    const scopes = JSON.parse(row.scopes || '[]');
    const tokens = issueOAuthTokens({ clientId: client.client_id, userId: row.userId, scopes, resource: row.resource });
    return {
      access_token: tokens.accessToken,
      token_type: 'bearer',
      expires_in: tokens.expiresIn,
      scope: scopes.join(' '),
      refresh_token: tokens.refreshToken
    };
  },

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const row = findOAuthTokenByRefresh(refreshToken);
    if (!row || row.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token tidak valid');
    }
    revokeOAuthTokenByRaw(refreshToken);
    const finalScopes = scopes && scopes.length ? scopes : JSON.parse(row.scopes || '[]');
    const tokens = issueOAuthTokens({
      clientId: client.client_id,
      userId: row.userId,
      scopes: finalScopes,
      resource: resource ? resource.href : row.resource
    });
    return {
      access_token: tokens.accessToken,
      token_type: 'bearer',
      expires_in: tokens.expiresIn,
      scope: finalScopes.join(' '),
      refresh_token: tokens.refreshToken
    };
  },

  async verifyAccessToken(token) {
    // 1) Token akses pribadi (PAT) statis, dibuat manual dari halaman Pengaturan.
    const pat = findApiTokenByRaw(token);
    if (pat) {
      touchApiToken(pat.id);
      return {
        token,
        clientId: 'pat',
        scopes: ['transactions'],
        expiresAt: Math.floor(Date.now() / 1000) + 315360000, // PAT tidak kedaluwarsa — nilai jauh di masa depan
        extra: { userId: pat.userId }
      };
    }
    // 2) Token akses hasil alur OAuth (konektor web seperti Claude.ai).
    const oat = findOAuthAccessToken(token);
    if (oat && oat.expiresAt > Math.floor(Date.now() / 1000)) {
      touchOAuthAccessToken(token);
      return {
        token,
        clientId: oat.clientId,
        scopes: JSON.parse(oat.scopes || '[]'),
        expiresAt: oat.expiresAt,
        extra: { userId: oat.userId }
      };
    }
    throw new InvalidTokenError('Token tidak valid atau sudah kedaluwarsa');
  },

  async revokeToken(client, request) {
    revokeOAuthTokenByRaw(request.token);
  }
};

// -------------------------------------------------------------------------
// Server MCP — tools Read/Write/Delete transaksi. Dibuat baru per-request
// (stateless) dan tools-nya menutup atas userId hasil autentikasi.
// -------------------------------------------------------------------------

const PAGE_SIZE = 10;

// Sumber tunggal info harga/limit plan, dipakai tool get_pricing_plans di
// bawah — angka ini harus tetap sinkron dengan kartu plan di dashboard.html
// dan batas harian di lib/transactions.js (addTransaction).
const PRICING_PLANS = {
  free: { nama: 'Free', hargaRupiah: 0, periode: null, limitTransaksiPerHari: 1, telegram: false, mcp: false },
  lite: { nama: 'Lite', hargaRupiah: 100000, periode: '3 hari', limitTransaksiPerHari: 3, telegram: false, mcp: false },
  pro: { nama: 'Pro', hargaRupiah: 5000000, periode: 'minggu', limitTransaksiPerHari: 50, telegram: true, mcp: true, limitTulisMcpTelegramPerHari: 3 },
  max: { nama: 'Max', hargaRupiah: 1000000000, periode: 'minggu', limitTransaksiPerHari: null, telegram: true, mcp: true }
};

const MCP_BANNED_OUTPUT = {
  content: [{
    type: 'text',
    text: 'Output banned: baca/tulis transaksi via MCP memerlukan langganan Pro atau Max. ' +
      'Akun ini masih boleh terhubung (pairing) — pakai get_pricing_plans untuk cek plan & harga, ' +
      'atau upgrade dulu di dashboard UangKu untuk membuka akses baca/tulis.'
  }],
  isError: true
};

function getMcpTier(userId) {
  return getLocalSubscription(userId);
}

// Pairing (koneksi OAuth/token) selalu diizinkan lepas dari plan — hanya
// baca/tulis transaksi (list/add/delete) yang dibatasi Pro/Max. get_pricing_plans
// juga selalu terbuka supaya user Free/Lite tetap bisa cek harga lewat AI-nya.
function canReadWriteMcp(userId) {
  const tier = getMcpTier(userId);
  return tier === 'pro' || tier === 'max';
}

function buildServerForUser(userId, clientId) {
  const sessionLabel = 'mcp:' + (clientId || 'unknown');
  const server = new McpServer(
    { name: 'uangku-mcp', version: '1.0.0' },
    {
      instructions:
        'Server MCP UangKu — akses transaksi keuangan pengguna. PENTING soal efisiensi token: ' +
        'add_transaction dan delete_transaction TIDAK mengembalikan seluruh riwayat transaksi, hanya ' +
        'konfirmasi ringkas + ringkasan saldo. Jangan panggil list_transactions secara otomatis setelah ' +
        'tiap add/delete — hanya panggil kalau pengguna memang minta melihat daftar transaksi, atau kamu ' +
        'benar-benar perlu memverifikasi sesuatu yang tidak bisa dipastikan dari konfirmasi yang sudah ada. ' +
        'list_transactions mengembalikan hasil per halaman (10 transaksi terbaru per halaman) untuk hemat ' +
        'token — pakai parameter "page" untuk mengambil halaman berikutnya kalau memang perlu, jangan ' +
        'mengambil semua halaman sekaligus kalau tidak diminta.'
    }
  );

  server.registerTool('get_pricing_plans', {
    title: 'Info Harga Plan Langganan',
    description:
      'Lihat daftar plan langganan UangKu (Free/Lite/Pro/Max) beserta harga, periode, limit transaksi ' +
      'harian, dan fitur (Telegram/MCP) masing-masing, plus plan & sisa kuota transaksi hari ini milik ' +
      'pengguna saat ini. Berguna kalau pengguna bertanya soal harga, upgrade, atau kenapa transaksinya ' +
      'ditolak karena limit harian.',
    inputSchema: {}
  }, async () => {
    const tier = getLocalSubscription(userId);
    const limit = PRICING_PLANS[tier]?.limitTransaksiPerHari ?? null;
    const usedToday = getTransactionCountToday(userId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          plans: PRICING_PLANS,
          planSaatIni: tier,
          transaksiHariIni: usedToday,
          limitTransaksiHariIni: limit,
          sisaKuotaHariIni: limit === null ? null : Math.max(0, limit - usedToday)
        }, null, 2)
      }]
    };
  });

  server.registerTool('list_transactions', {
    title: 'Daftar Transaksi',
    description:
      'Baca daftar transaksi keuangan pengguna beserta ringkasan saldo/pemasukan/pengeluaran, dipaginasi ' +
      `${PAGE_SIZE} transaksi terbaru per halaman untuk hemat token. Bisa difilter jenis dan dicari ` +
      'berdasarkan keterangan. Panggil ini hanya kalau pengguna minta lihat transaksi atau kamu benar-benar ' +
      'perlu memverifikasi data — jangan dipanggil otomatis setelah add/delete.',
    inputSchema: {
      jenis: z.enum(['masuk', 'keluar']).optional().describe('Filter jenis transaksi: masuk (pemasukan) atau keluar (pengeluaran). Kosongkan untuk semua.'),
      cari: z.string().optional().describe('Cari transaksi yang keterangannya mengandung teks ini (case-insensitive).'),
      page: z.number().int().positive().optional().describe(`Nomor halaman, dimulai dari 1 (${PAGE_SIZE} transaksi terbaru per halaman). Default 1.`)
    }
  }, async ({ jenis, cari, page }) => {
    if (!canReadWriteMcp(userId)) return MCP_BANNED_OUTPUT;
    const data = getTransactions(userId);
    let rows = data.transaksi;
    if (jenis) rows = rows.filter((t) => t.jenis === jenis);
    if (cari) { const q = cari.toLowerCase(); rows = rows.filter((t) => t.keterangan.toLowerCase().includes(q)); }

    const totalItems = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
    const currentPage = Math.min(Math.max(page || 1, 1), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ringkasan: data.ringkasan,
          halaman: { saatIni: currentPage, totalHalaman: totalPages, totalTransaksi: totalItems, adaHalamanBerikutnya: currentPage < totalPages },
          transaksi: pageRows
        }, null, 2)
      }]
    };
  });

  server.registerTool('add_transaction', {
    title: 'Tambah Transaksi',
    description:
      'Catat satu transaksi keuangan baru (pemasukan atau pengeluaran) ke laporan UangKu pengguna. ' +
      'Mengembalikan konfirmasi ringkas + ringkasan saldo saja (bukan seluruh riwayat transaksi) — ' +
      'jangan panggil list_transactions sesudahnya kecuali pengguna minta melihat daftar.',
    inputSchema: {
      jenis: z.enum(['masuk', 'keluar']).describe('masuk = pemasukan, keluar = pengeluaran'),
      keterangan: z.string().min(1).max(120).describe('Deskripsi singkat transaksi, mis. "Gaji Bulanan" atau "Belanja Indomaret"'),
      jumlah: z.number().int().positive().describe('Nominal transaksi dalam Rupiah, bilangan bulat positif')
    }
  }, async ({ jenis, keterangan, jumlah }) => {
    if (!canReadWriteMcp(userId)) return MCP_BANNED_OUTPUT;
    const writeLimit = checkMcpTelegramWriteLimit(userId, getMcpTier(userId));
    if (!writeLimit.allowed) return { content: [{ type: 'text', text: writeLimit.error }], isError: true };
    const result = addTransaction(userId, jenis, keterangan, String(jumlah), { sessionLabel });
    if (result.error) return { content: [{ type: 'text', text: `Gagal: ${result.error}` }], isError: true };
    const transaksiBaru = result.transaksi[0]; // baris terbaru — hasil query terurut id DESC
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ berhasil: true, transaksi_baru: transaksiBaru, ringkasan: result.ringkasan }, null, 2)
      }]
    };
  });

  server.registerTool('delete_transaction', {
    title: 'Hapus Transaksi',
    description:
      'Hapus satu transaksi milik pengguna berdasarkan ID-nya (dapatkan ID lewat list_transactions ' +
      'terlebih dulu). Mengembalikan konfirmasi ringkas + ringkasan saldo saja (bukan seluruh riwayat) — ' +
      'jangan panggil list_transactions sesudahnya kecuali pengguna minta melihat daftar.',
    inputSchema: { id: z.number().int().describe('ID transaksi yang akan dihapus') }
  }, async ({ id }) => {
    if (!canReadWriteMcp(userId)) return MCP_BANNED_OUTPUT;
    const writeLimit = checkMcpTelegramWriteLimit(userId, getMcpTier(userId));
    if (!writeLimit.allowed) return { content: [{ type: 'text', text: writeLimit.error }], isError: true };
    const result = deleteTransaction(userId, id, { sessionLabel });
    if (result.error) return { content: [{ type: 'text', text: `Gagal: ${result.error}` }], isError: true };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ berhasil: true, id_dihapus: id, ringkasan: result.ringkasan }, null, 2)
      }]
    };
  });

  return server;
}

// -------------------------------------------------------------------------
// App Express — endpoint OAuth (discovery, DCR, authorize, token, revoke)
// dipasang oleh mcpAuthRouter; endpoint MCP dilindungi Bearer token.
// -------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

app.use(mcpAuthRouter({
  provider,
  issuerUrl: new URL(ORIGIN),
  resourceServerUrl: new URL(`${ORIGIN}/mcp`),
  serviceDocumentationUrl: new URL(`${ORIGIN}/mcp-docs`),
  scopesSupported: ['transactions']
}));

app.post('/authorize/decision', express.urlencoded({ extended: false }), async (req, res) => {
  const user = await currentUserFromCookies(req);
  if (!user) {
    res.redirect(`${ORIGIN}/login`);
    return;
  }
  const { client_id, redirect_uri, state, code_challenge, scope, resource, decision } = req.body;
  const client = await provider.clientsStore.getClient(client_id);
  if (!client || !redirect_uri) {
    res.status(400).send('Permintaan otorisasi tidak valid.');
    return;
  }
  const redirectUrl = new URL(redirect_uri);
  if (decision !== 'approve') {
    redirectUrl.searchParams.set('error', 'access_denied');
    if (state) redirectUrl.searchParams.set('state', state);
    res.redirect(redirectUrl.href);
    return;
  }
  const scopes = scope ? scope.split(' ').filter(Boolean) : [];
  const code = createAuthorizationCode({
    clientId: client_id,
    userId: user.id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    scopes,
    resource: resource || undefined
  });
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);
  res.redirect(redirectUrl.href);
});

const bearerAuth = requireBearerAuth({
  verifier: provider,
  requiredScopes: [],
  resourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`
});

app.all('/mcp', express.json(), bearerAuth, async (req, res) => {
  const userId = req.auth.extra.userId;

  try {
    const server = buildServerForUser(userId, req.auth.clientId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request error:', err.message);
    if (!res.headersSent) { res.status(500).json({ error: 'Internal Server Error' }); }
  }
});

app.use((req, res) => { res.status(404).json({ error: 'Not Found' }); });

app.listen(PORT, HOST, () => {
  console.log(`🔌 Server MCP UangKu (OAuth) jalan di http://${HOST}:${PORT}/mcp`);
});
