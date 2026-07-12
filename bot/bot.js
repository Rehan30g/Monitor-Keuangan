import '../lib/env.js';
import { createRateLimiter } from '../lib/http-utils.js';
import { createLinkToken, getUserIdByChat, unlinkChat } from '../lib/telegram-links.js';
import { askFinanceAgent } from '../lib/openrouter.js';
import { addTransaction, formatRupiah } from '../lib/transactions.js';
import { findUserById } from '../lib/auth.js';
import { tgApi, sendTelegramMessage, fileBase } from '../lib/telegram-api.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://huzky.xyz';

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN belum diset di .env');
  process.exit(1);
}

const messageLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 15 });
const loginLimiter = createRateLimiter({ windowMs: 5 * 60 * 1000, max: 5 });

const sendMessage = sendTelegramMessage;

// Antrean per-chat: kalau pesan kedua masuk sementara pesan pertama masih
// diproses AI, jangan proses dua-duanya berbarengan (bisa balasan tertukar
// urutan atau transaksi tercatat dobel) — antre, proses satu per satu per chat.
const chatQueues = new Map(); // chatId -> Promise (ekor antrean chat itu)
const chatBusy = new Set(); // chatId yang sedang diproses AI saat ini

function queueForChat(chatId, task) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(task, task);
  chatQueues.set(chatId, next.catch(() => {}));
  return next;
}

async function setReaction(chatId, messageId, emoji) {
  return tgApi('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: emoji ? [{ type: 'emoji', emoji }] : []
  }).catch(() => {});
}

function startTypingHeartbeat(chatId) {
  const ping = () => tgApi('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4000); // Telegram cuma nahan status "mengetik" ~5 detik
  return () => clearInterval(timer);
}

async function downloadPhotoBase64(fileId) {
  const fileInfo = await tgApi('getFile', { file_id: fileId });
  const filePath = fileInfo.result?.file_path;
  if (!filePath) throw new Error('Gagal mengambil file dari Telegram.');

  const response = await fetch(`${fileBase()}/${filePath}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = filePath.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  return { base64: buffer.toString('base64'), mime };
}

async function handleLogin(chatId) {
  if (loginLimiter(String(chatId))) {
    return sendMessage(chatId, 'Terlalu banyak permintaan login. Coba lagi beberapa menit lagi.');
  }
  const { token } = createLinkToken(chatId);
  const link = `${PUBLIC_BASE_URL}/link-telegram?token=${token}`;
  await sendMessage(
    chatId,
    `Untuk menghubungkan chat ini ke akun UangKu kamu, buka link berikut di browser (pastikan sudah login ke huzky.xyz):\n\n${link}\n\nLink berlaku 10 menit.`
  );
}

async function handleFinanceMessage(chatId, userId, messageId, { text, imageBase64, imageMime }) {
  // Feedback instan supaya user tahu AI sedang memproses: reaksi 👀 di pesannya
  // + status "mengetik" yang terus di-refresh selama proses berjalan.
  setReaction(chatId, messageId, '👀');
  const stopTyping = startTypingHeartbeat(chatId);

  let result;
  try {
    result = await askFinanceAgent({ text, imageBase64, imageMime });
  } catch (err) {
    console.error('Gagal memproses pesan via OpenRouter:', err.message);
    return sendMessage(chatId, 'Maaf, terjadi kesalahan saat memproses pesan kamu. Coba lagi nanti.');
  } finally {
    stopTyping();
    setReaction(chatId, messageId, null); // reaksi hilang begitu balasan siap/gagal
  }

  if (result.toolCalls.length === 0) {
    return sendMessage(chatId, result.replyText || 'Tidak menemukan informasi transaksi pada pesan/foto ini.');
  }

  const saved = [];
  const failed = [];

  for (const call of result.toolCalls) {
    const outcome = addTransaction(userId, call.jenis, call.keterangan, call.jumlah);
    if (outcome.error) {
      failed.push(`${call.keterangan}: ${outcome.error}`);
    } else {
      saved.push(`${call.jenis === 'masuk' ? '+' : '-'} ${formatRupiah(call.jumlah)} — ${call.keterangan}`);
    }
  }

  let reply = '';
  if (saved.length > 0) {
    reply += `Tersimpan ke laporan huzky.xyz:\n${saved.join('\n')}`;
  }
  if (failed.length > 0) {
    reply += `${reply ? '\n\n' : ''}Gagal mencatat:\n${failed.join('\n')}`;
  }
  return sendMessage(chatId, reply);
}

async function handleUpdate(update) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;

  if (messageLimiter(String(chatId))) {
    return sendMessage(chatId, 'Terlalu banyak pesan dalam waktu singkat. Tunggu sebentar lalu coba lagi.');
  }

  const text = (message.text || message.caption || '').trim();

  if (text === '/start') {
    return sendMessage(
      chatId,
      'Halo! Aku bot UangKu huzky.xyz.\n\nKetik /login untuk menghubungkan chat ini ke akun kamu, lalu kirim foto struk atau catatan teks dan aku akan otomatis mencatatnya sebagai transaksi.'
    );
  }
  if (text === '/login') {
    return handleLogin(chatId);
  }
  if (text === '/logout') {
    unlinkChat(chatId);
    return sendMessage(chatId, 'Chat ini sudah diputus dari akun huzky.xyz kamu.');
  }

  const userId = getUserIdByChat(chatId);
  if (!userId) {
    return sendMessage(chatId, 'Chat ini belum terhubung ke akun huzky.xyz. Ketik /login untuk menghubungkan.');
  }

  const user = findUserById(userId);
  if (!user) {
    unlinkChat(chatId);
    return sendMessage(chatId, 'Akun terkait tidak ditemukan lagi. Ketik /login untuk menghubungkan ulang.');
  }

  let payload;

  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    let imageBase64, imageMime;
    try {
      ({ base64: imageBase64, mime: imageMime } = await downloadPhotoBase64(largest.file_id));
    } catch (err) {
      console.error('Gagal mengunduh foto:', err.message);
      return sendMessage(chatId, 'Gagal mengunduh foto dari Telegram. Coba kirim ulang.');
    }
    payload = { text, imageBase64, imageMime };
  } else if (text) {
    payload = { text };
  } else {
    return sendMessage(chatId, 'Kirim teks atau foto struk/catatan untuk dicatat sebagai transaksi.');
  }

  if (chatBusy.has(chatId)) {
    sendMessage(chatId, '⏳ Masih memproses pesan sebelumnya — pesan ini akan diproses setelah itu selesai.');
  }

  return queueForChat(chatId, async () => {
    chatBusy.add(chatId);
    try {
      await handleFinanceMessage(chatId, userId, messageId, payload);
    } finally {
      chatBusy.delete(chatId);
    }
  });
}

async function pollLoop() {
  let offset = 0;
  console.log('Bot Telegram UangKu berjalan (long polling)...');

  while (true) {
    try {
      const data = await tgApi('getUpdates', { offset, timeout: 30 });
      const updates = data.result || [];

      for (const update of updates) {
        offset = update.update_id + 1;
        handleUpdate(update).catch((err) => console.error('Gagal menangani update:', err.message));
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

tgApi('getMe').then((data) => {
  if (data.ok) {
    console.log(`Terhubung sebagai @${data.result.username}`);
    pollLoop();
  } else {
    console.error('Gagal terhubung ke Telegram API. Periksa TELEGRAM_BOT_TOKEN.');
    process.exit(1);
  }
});
