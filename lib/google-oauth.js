// "Masuk dengan Google" — bagian yang TETAP di UangKu: hanya state anti-CSRF
// (cookie browser-facing) dan konfigurasi/redirect URL. Token exchange +
// pencocokan akun (dulu exchangeCodeForTokens/fetchUserInfo/resolveGoogleLogin
// di sini) sudah pindah ke accounts service (/root/accounts/lib/google.js) —
// dipanggil lewat POST /internal/google/exchange, lihat handlers.js.
// TIDAK berhubungan dengan provider OAuth 2.1 MCP di /mcp — itu alur berbeda.
import crypto from 'crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

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

export {
  REDIRECT_URI,
  getGoogleConfig,
  isGoogleConfigured,
  createState,
  consumeState,
  buildAuthUrl
};
