function apiBase() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum diset.');
  return `https://api.telegram.org/bot${token}`;
}

function fileBase() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN belum diset.');
  return `https://api.telegram.org/file/bot${token}`;
}

async function tgApi(method, params) {
  const response = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {})
  });
  const data = await response.json();
  if (!data.ok) {
    console.error(`Telegram API error (${method}):`, data.description);
  }
  return data;
}

function sendTelegramMessage(chatId, text) {
  return tgApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

export { tgApi, sendTelegramMessage, fileBase };
