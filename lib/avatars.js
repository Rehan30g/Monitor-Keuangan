import fs from 'fs';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const AVATAR_DIR = path.resolve(__dirname, '..', 'data', 'avatars');

fs.mkdirSync(AVATAR_DIR, { recursive: true });

const MIME_TO_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};

function extForMime(mime) {
  return MIME_TO_EXT[mime] || null;
}

function avatarPath(userId, ext) {
  // userId adalah UUID (dari crypto.randomUUID) — aman dipakai langsung sebagai nama file.
  return path.join(AVATAR_DIR, `${userId}.${ext}`);
}

function saveAvatar(userId, buffer, ext) {
  // Hapus file lama dulu (mungkin ekstensi berbeda dari upload sebelumnya).
  removeAvatar(userId);
  fs.writeFileSync(avatarPath(userId, ext), buffer);
}

function removeAvatar(userId) {
  for (const ext of Object.values(MIME_TO_EXT)) {
    const p = avatarPath(userId, ext);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function readAvatar(userId, ext) {
  const p = avatarPath(userId, ext);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

export { extForMime, MIME_TO_EXT, saveAvatar, removeAvatar, readAvatar };
