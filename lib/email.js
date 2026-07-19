const RESEND_API_URL = 'https://api.resend.com/emails';

async function sendViaResend({ to, subject, html, attachments }) {
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
      body: JSON.stringify({ from, to: [to], subject, html, ...(attachments ? { attachments } : {}) })
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

function renderPasswordResetHtml(resetLink) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Reset Password</h2>
      <p>Kami menerima permintaan untuk mereset password akun UangKu kamu. Klik tombol di bawah untuk membuat password baru:</p>
      <p><a href="${resetLink}" style="display:inline-block; background:#0d6efd; color:#ffffff; text-decoration:none; padding:10px 20px; border-radius:6px; font-weight:600;">Reset Password</a></p>
      <p style="color:#6c757d; font-size: 0.85rem;">Atau salin link ini ke browser: ${resetLink}</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Link berlaku 30 menit. Jika kamu tidak meminta ini, abaikan saja email ini — password kamu tidak akan berubah.</p>
    </div>
  `;
}

async function sendPasswordResetEmail(to, resetLink) {
  return sendViaResend({
    to,
    subject: 'Reset Password Akun UangKu',
    html: renderPasswordResetHtml(resetLink)
  });
}

function renderPasswordChangedHtml() {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Password Telah Diubah</h2>
      <p>Password akun UangKu kamu baru saja diubah.</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika ini bukan kamu, segera hubungi kami atau amankan email yang terhubung ke akun ini.</p>
    </div>
  `;
}

async function sendPasswordChangedEmail(to) {
  return sendViaResend({
    to,
    subject: 'Password Akun UangKu Diubah',
    html: renderPasswordChangedHtml()
  });
}

function renderPasswordSetHtml(revertLink) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Password Baru Dibuat</h2>
      <p>Sebuah password baru baru saja dibuat untuk akun UangKu kamu. Sebelumnya akun ini belum punya password (misalnya karena kamu masuk lewat Google), dan sekarang kamu juga bisa login dengan password.</p>
      <p>Jika ini kamu, tidak ada yang perlu dilakukan.</p>
      <p><strong>Jika ini BUKAN kamu</strong>, akunmu mungkin diakses orang lain — klik tombol di bawah untuk segera mengganti password (tanpa perlu tahu password yang baru saja dibuat):</p>
      <p><a href="${revertLink}" style="display:inline-block; background:#0d6efd; color:#ffffff; text-decoration:none; padding:10px 20px; border-radius:6px; font-weight:600;">Ganti Password Sekarang</a></p>
      <p style="color:#6c757d; font-size: 0.85rem;">Atau salin link ini ke browser: ${revertLink}</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Link berlaku 14 hari.</p>
    </div>
  `;
}

async function sendPasswordSetEmail(to, revertLink) {
  return sendViaResend({
    to,
    subject: 'Password Akun UangKu Dibuat',
    html: renderPasswordSetHtml(revertLink)
  });
}

function renderDataExportHtml(username) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Ekspor Data Kamu</h2>
      <p>Halo <strong>${escapeHtml(username)}</strong>, sesuai permintaan kamu, seluruh data transaksi di akun UangKu kamu terlampir dalam format CSV (bisa dibuka di Excel/Google Sheets).</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika kamu tidak meminta ini, segera ganti password akun kamu.</p>
    </div>
  `;
}

async function sendDataExportEmail(to, username, csvContent) {
  return sendViaResend({
    to,
    subject: 'Ekspor Data Akun UangKu',
    html: renderDataExportHtml(username),
    attachments: [
      { filename: 'uangku-data.csv', content: Buffer.from(csvContent, 'utf8').toString('base64') }
    ]
  });
}

function renderAccountDeletedHtml(username) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Akun Telah Dihapus</h2>
      <p>Akun UangKu <strong>${escapeHtml(username)}</strong> telah dijadwalkan untuk dihapus. Data kamu (transaksi, profil, koneksi Telegram) masih tersimpan sementara.</p>
      <p>Jika ini sebuah kesalahan, akun masih bisa dipulihkan sepenuhnya dalam 7 hari — hubungi admin untuk memulihkannya sebelum data dihapus permanen.</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika ini bukan kamu, kemungkinan akun kamu diakses orang lain — segera hubungi kami.</p>
    </div>
  `;
}

async function sendAccountDeletedEmail(to, username) {
  return sendViaResend({
    to,
    subject: 'Akun UangKu Telah Dihapus',
    html: renderAccountDeletedHtml(username)
  });
}

function renderEmailChangeVerifyHtml(code) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Konfirmasi Email Baru</h2>
      <p>Gunakan kode berikut untuk mengonfirmasi alamat email ini sebagai email baru akun UangKu kamu:</p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color:#1a1a1a;">${code}</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Kode berlaku 10 menit. Jika kamu tidak meminta ini, abaikan saja email ini.</p>
    </div>
  `;
}

async function sendEmailChangeVerification(to, code) {
  return sendViaResend({
    to,
    subject: 'Konfirmasi Email Baru UangKu',
    html: renderEmailChangeVerifyHtml(code)
  });
}

function renderEmailChangedNoticeHtml(newEmail) {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Email Akun Telah Diubah</h2>
      <p>Email akun UangKu kamu telah diganti ke <strong>${escapeHtml(newEmail)}</strong>.</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika ini bukan kamu, segera hubungi kami — akun kamu mungkin diakses orang lain.</p>
    </div>
  `;
}

async function sendEmailChangedNotice(to, newEmail) {
  return sendViaResend({
    to,
    subject: 'Email Akun UangKu Diubah',
    html: renderEmailChangedNoticeHtml(newEmail)
  });
}

function renderMfaEnabledHtml() {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Verifikasi Dua Langkah Aktif</h2>
      <p>Verifikasi dua langkah (2FA) baru saja diaktifkan di akun UangKu kamu. Mulai sekarang, login butuh kode dari aplikasi authenticator kamu.</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika ini bukan kamu, segera ganti password akun kamu dan amankan email ini.</p>
    </div>
  `;
}

async function sendMfaEnabledEmail(to) {
  return sendViaResend({
    to,
    subject: 'Verifikasi Dua Langkah UangKu Diaktifkan',
    html: renderMfaEnabledHtml()
  });
}

function renderMfaDisabledHtml() {
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#0d6efd;">Verifikasi Dua Langkah Dinonaktifkan</h2>
      <p>Verifikasi dua langkah (2FA) baru saja dinonaktifkan di akun UangKu kamu. Login sekarang hanya memerlukan password.</p>
      <p style="color:#6c757d; font-size: 0.9rem;">Jika ini bukan kamu, segera ganti password akun kamu — akunmu mungkin diakses orang lain.</p>
    </div>
  `;
}

async function sendMfaDisabledEmail(to) {
  return sendViaResend({
    to,
    subject: 'Verifikasi Dua Langkah UangKu Dinonaktifkan',
    html: renderMfaDisabledHtml()
  });
}

export {
  sendVerificationEmail,
  sendLoginAlertEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendPasswordSetEmail,
  sendDataExportEmail,
  sendAccountDeletedEmail,
  sendEmailChangeVerification,
  sendEmailChangedNotice,
  sendMfaEnabledEmail,
  sendMfaDisabledEmail
};
