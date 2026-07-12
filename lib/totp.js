import crypto from 'crypto';

// Implementasi TOTP (RFC 6238) di atas HOTP (RFC 4226) memakai HANYA modul
// `crypto` bawaan Node — tanpa dependency. Kompatibel dengan Google
// Authenticator, Authy, 1Password, dll (HMAC-SHA1, step 30 detik, 6 digit).

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'UangKu';

// Base32 (RFC 4648) — secret TOTP lazim ditampilkan/di-scan sebagai base32.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  // Buang padding & spasi, samakan huruf besar — authenticator app kadang
  // menampilkan secret dengan spasi tiap 4 karakter.
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue; // abaikan karakter non-base32
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Secret standar 160-bit (20 byte) acak, disimpan/ditampilkan sebagai base32.
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// HOTP: HMAC-SHA1(secret, counter 8-byte big-endian) → dynamic truncation →
// mod 10^DIGITS → zero-pad.
function hotp(secretBuffer, counter) {
  const counterBuf = Buffer.alloc(8);
  // counter muat di 32-bit rendah untuk rentang waktu realistis; 4 byte atas 0.
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', secretBuffer).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 10 ** DIGITS;
  return String(otp).padStart(DIGITS, '0');
}

// Hitung kode TOTP saat ini untuk secret base32 (dipakai juga oleh test).
function generateTotp(secretBase32, forTime = Date.now()) {
  const counter = Math.floor(forTime / 1000 / STEP_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

// Verifikasi: terima window saat ini ±1 step (toleransi drift jam ±30 detik,
// praktik standar) supaya kode tidak salah tolak karena selisih jam kecil.
// Bandingkan timing-safe untuk tiap kandidat.
function verifyTotp(secretBase32, token, window = 1) {
  const cleaned = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  const secretBuffer = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  const submitted = Buffer.from(cleaned);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    const candidate = hotp(secretBuffer, counter + errorWindow);
    const candidateBuf = Buffer.from(candidate);
    if (
      candidateBuf.length === submitted.length &&
      crypto.timingSafeEqual(candidateBuf, submitted)
    ) {
      return true;
    }
  }
  return false;
}

// URI otpauth standar untuk ditampilkan sebagai teks (bisa di-paste manual di
// authenticator app; sebagian app juga bisa membaca URI ini via clipboard/QR).
function buildOtpauthUri(username, secretBase32) {
  const label = encodeURIComponent(`${ISSUER}:${username}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export {
  generateSecret,
  generateTotp,
  verifyTotp,
  buildOtpauthUri,
  base32Encode,
  base32Decode
};
