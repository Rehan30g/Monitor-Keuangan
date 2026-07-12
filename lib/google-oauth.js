// "Masuk dengan Google" (OAuth 2.0 Authorization Code flow) untuk aplikasi utama.
// TIDAK berhubungan dengan provider OAuth 2.1 MCP di /mcp — itu alur berbeda.
import crypto from 'crypto';
import {
  findUserByGoogleId,
  findUserByEmail,
  linkGoogleAccount,
  findUserById
} from './auth.js';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

// Redirect URI HARUS sama persis dengan yang didaftarkan di Google Cloud Console.
const REDIRECT_URI = 'https://huzky.xyz/api/auth/google/callback';

// Konfigurasi hanya aktif bila kedua env var ada. Absennya ditangani anggun
// (tombol disembunyikan / route balas 501), bukan crash.
function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: REDIRECT_URI };
}

function isGoogleConfigured() {
  return getGoogleConfig() !== null;
}

// --- State store server-side dengan TTL (anti-CSRF) ----------------------
const STATE_TTL_MS = 10 * 60 * 1000; // 10 menit
const stateStore = new Map(); // state -> createdAt

function createState() {
  const state = crypto.randomBytes(24).toString('hex');
  stateStore.set(state, Date.now());
  return state;
}

// Validasi + konsumsi (single-use). Sekaligus bersihkan state kedaluwarsa.
function consumeState(state) {
  const now = Date.now();
  for (const [key, createdAt] of stateStore) {
    if (now - createdAt > STATE_TTL_MS) stateStore.delete(key);
  }
  if (!state || !stateStore.has(state)) return false;
  stateStore.delete(state);
  return true;
}

function buildAuthUrl(state) {
  const cfg = getGoogleConfig();
  if (!cfg) return null;
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online'
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// Tukar authorization code menjadi token (server-to-server, TLS ke Google).
async function exchangeCodeForTokens(code) {
  const cfg = getGoogleConfig();
  if (!cfg) throw new Error('Google OAuth belum dikonfigurasi.');
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code'
  });
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange gagal (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// Ambil profil user dari endpoint userinfo pakai access token (TLS ke Google).
async function fetchUserInfo(accessToken) {
  const resp = await fetch(USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) {
    throw new Error(`Userinfo gagal (${resp.status}).`);
  }
  return resp.json();
}

// Normalisasi profil userinfo Google menjadi bentuk internal yang dipakai
// resolveGoogleLogin. email_verified bisa boolean atau string "true".
function normalizeProfile(info) {
  const emailVerified =
    info.email_verified === true || info.email_verified === 'true';
  return {
    sub: info.sub ? String(info.sub) : '',
    email: info.email ? String(info.email).trim().toLowerCase() : '',
    emailVerified,
    name: info.name || info.given_name || '',
    // URL foto profil Google (opsional). Dipakai untuk auto-impor avatar sekali
    // saat login/daftar bila akun belum punya avatar. Kosong bila tak ada.
    picture: info.picture ? String(info.picture) : ''
  };
}

// --- Inti logika pencocokan akun (sengaja dipisah agar bisa diuji murni) --
//
// Mengembalikan { user } saat login boleh lanjut, { newSignup } saat harus
// membuat akun baru (user perlu memilih username dulu — akun BELUM dibuat di
// sini), atau { error: <kode> } saat harus ditolak. Kode error: 'google_no_sub'
// | 'google_email_unverified' | 'account_deleted' | 'link_requires_verified_email'.
//
// Aturan keamanan:
//  1. google_id cocok → login langsung.
//  2. email ada & terverifikasi Google → cari user by email:
//     - ada & email terverifikasi di sistem kita → auto-link, login.
//     - ada tapi BELUM terverifikasi di sistem kita → TOLAK (penyerang bisa
//       mendaftarkan email korban tanpa memverifikasinya; auto-link akan
//       menyerahkan akun itu ke penyerang). Jangan link, jangan buat akun baru.
//     - tidak ada → buat akun baru (email sudah diverifikasi Google).
//  3. tidak ada email / tidak terverifikasi Google → tolak.
function resolveGoogleLogin(profile) {
  const { sub, email, emailVerified, name, picture } = profile;
  if (!sub) return { error: 'google_no_sub' };

  // 1) Sudah tertaut lewat google_id.
  const byGoogleId = findUserByGoogleId(sub);
  if (byGoogleId) {
    if (byGoogleId.deletedAt) return { error: 'account_deleted' };
    return { user: byGoogleId };
  }

  // 2/3) Butuh email yang diverifikasi Google untuk lanjut.
  if (!email || !emailVerified) return { error: 'google_email_unverified' };

  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.deletedAt) return { error: 'account_deleted' };
    if (!existing.emailVerified) {
      // Email terklaim tapi belum dibuktikan di sistem kita — jangan serahkan.
      return { error: 'link_requires_verified_email' };
    }
    linkGoogleAccount(existing.id, sub);
    return { user: findUserById(existing.id) };
  }

  // 3) Belum ada akun dengan email ini → JANGAN buat langsung. Serahkan ke
  // pemanggil untuk menyimpan profil pending & mengarahkan user memilih
  // username sendiri (email sudah diverifikasi Google, tak perlu dicek ulang).
  return { newSignup: { email, googleId: sub, displayName: name, picture: picture || '' } };
}

export {
  REDIRECT_URI,
  getGoogleConfig,
  isGoogleConfigured,
  createState,
  consumeState,
  buildAuthUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
  normalizeProfile,
  resolveGoogleLogin
};
