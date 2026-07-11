const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;
// Validasi email longgar namun cukup untuk cegah input yang jelas salah; verifikasi asli
// tetap terjadi lewat pengiriman kode ke alamat tsb.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateUsername(username) {
  if (typeof username !== 'string') return false;
  return USERNAME_RE.test(username);
}

function validateEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > 254) return false;
  return EMAIL_RE.test(email);
}

function validatePassword(password) {
  if (typeof password !== 'string') return false;
  return password.length >= 8 && password.length <= 256;
}

function normalizeUsername(username) {
  return String(username).trim().toLowerCase();
}

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

export {
  validateUsername,
  validatePassword,
  validateEmail,
  normalizeUsername,
  normalizeEmail
};
