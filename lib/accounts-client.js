// Client tipis untuk accounts service (identitas/sesi bersama UangKu + imagegen).
// Service itu sendiri 127.0.0.1-only, tidak pernah terekspos lewat nginx —
// dipanggil server-to-server dari sini.
import './env.js';

const BASE_URL = process.env.ACCOUNTS_SERVICE_URL || 'http://127.0.0.1:3010';
const INTERNAL_KEY = process.env.INTERNAL_API_KEY || '';

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'X-Internal-Key': INTERNAL_KEY,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const status = res.status;
  let json = {};
  try {
    json = await res.json();
  } catch {
    json = {};
  }
  return { status, body: json };
}

function get(path) {
  return call('GET', path);
}
function post(path, body) {
  return call('POST', path, body || {});
}
function del(path) {
  return call('DELETE', path);
}

export const accounts = {
  get,
  post,
  del,
  baseUrl: BASE_URL
};
