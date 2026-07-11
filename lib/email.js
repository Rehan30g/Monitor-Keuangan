const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey || !from) {
    console.error('RESEND_API_KEY / RESEND_FROM_EMAIL belum diset. Email tidak terkirim.');
    return { ok: false, skipped: true };
  }

  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, html })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('Gagal mengirim email via Resend:', response.status, errBody);
      return { ok: false, statusCode: response.status };
    }

    return { ok: true };
  } catch (err) {
    console.error('Gagal mengirim email via Resend:', err.message);
    return { ok: false };
  }
}

function renderCodeEmailHtml(code) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Verifikasi Email</h2>
      <p>Gunakan kode berikut untuk memverifikasi email kamu:</p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color:#1a1a1a;">${code}</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Kode berlaku 10 menit. Abaikan email ini jika kamu tidak meminta kode ini.</p>
    </div>
  `;
}

async function sendVerificationEmail(to, code) {
  return sendViaResend({
    to,
    subject: 'Verifikasi Email Huzky.xyz',
    html: renderCodeEmailHtml(code)
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag] || tag));
}

function renderLoginAlertHtml({ username, time, ip, userAgent }) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Login Baru Terdeteksi</h2>
      <p>Akun <strong>${escapeHtml(username)}</strong> baru saja login.</p>
      <table style="font-size: 0.9rem; color:#495057;">
        <tr><td style="padding:4px 8px 4px 0;">Waktu</td><td>${escapeHtml(time)}</td></tr>
        <tr><td style="padding:4px 8px 4px 0;">Alamat IP</td><td>${escapeHtml(ip)}</td></tr>
        <tr><td style="padding:4px 8px 4px 0;">Perangkat</td><td>${escapeHtml(userAgent)}</td></tr>
      </table>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika ini bukan kamu, segera ganti password akun kamu.</p>
    </div>
  `;
}

async function sendLoginAlertEmail(to, meta) {
  return sendViaResend({
    to,
    subject: 'Login Baru ke Akun Huzky.xyz',
    html: renderLoginAlertHtml(meta)
  });
}

export { sendVerificationEmail, sendLoginAlertEmail };
