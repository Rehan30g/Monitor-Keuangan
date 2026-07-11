const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyCaptcha(token, remoteIp) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;

  if (!secretKey) {
    console.error('TURNSTILE_SECRET_KEY belum diset. Captcha tidak diverifikasi.');
    return false;
  }
  if (!token) {
    return false;
  }

  try {
    const params = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) params.set('remoteip', remoteIp);

    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    const data = await response.json();
    return Boolean(data.success);
  } catch (err) {
    console.error('Gagal memverifikasi captcha:', err.message);
    return false;
  }
}

export { verifyCaptcha };
