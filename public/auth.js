// Kalau halaman ini dibuka lewat redirect eksternal (mis. dari alur OAuth MCP)
// dengan ?returnTo=..., simpan supaya login.js tahu ke mana harus kembali.
(function tangkapReturnTo() {
  const returnTo = new URLSearchParams(window.location.search).get('returnTo');
  if (returnTo) sessionStorage.setItem('postLoginRedirect', returnTo);
})();

let turnstileWidgetId = null;

window.onTurnstileLoad = function () {
  const container = document.getElementById('turnstile-container');
  if (!container || !window.turnstile) return;

  fetch('/api/config')
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.turnstileSiteKey) {
        turnstileWidgetId = window.turnstile.render(container, {
          sitekey: cfg.turnstileSiteKey
        });
      }
    })
    .catch((err) => console.error('Gagal memuat konfigurasi captcha:', err));
};

function getCaptchaToken() {
  if (window.turnstile && turnstileWidgetId !== null) {
    return window.turnstile.getResponse(turnstileWidgetId);
  }
  return '';
}

function resetCaptcha() {
  if (window.turnstile && turnstileWidgetId !== null) {
    window.turnstile.reset(turnstileWidgetId);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const registerForm = document.getElementById('register-form');
  const loginForm = document.getElementById('login-form');
  const verifyForm = document.getElementById('verify-form');
  const forgotForm = document.getElementById('forgot-form');
  const resetForm = document.getElementById('reset-form');
  const errorEl = document.getElementById('auth-error');

  function showError(message) {
    if (errorEl) {
      errorEl.textContent = message;
    }
  }

  async function submitAuth(url, payload) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch'
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  }

  function goToVerify(token, message) {
    const params = new URLSearchParams({ token });
    if (message) params.set('msg', message);
    window.location.href = `/verify?${params.toString()}`;
  }

  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const username = registerForm.username.value.trim();
      const email = registerForm.email.value.trim();
      const password = registerForm.password.value;
      const captchaToken = getCaptchaToken();

      const { ok, data } = await submitAuth('/api/register', { username, email, password, captchaToken });
      if (ok) {
        // Pesan disimpan dalam bentuk Indonesia (kanonik); diterjemahkan saat tampil.
        goToVerify(data.verifyToken, 'Kode verifikasi telah dikirim ke email kamu.');
      } else {
        showError(data.error ? window.tServer(data.error) : window.t('auth.regFail'));
        resetCaptcha();
      }
    });
  }

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const username = loginForm.username.value.trim();
      const password = loginForm.password.value;
      const captchaToken = getCaptchaToken();

      const { ok, status, data } = await submitAuth('/api/login', { username, password, captchaToken });
      if (ok) {
        const redirectTo = sessionStorage.getItem('postLoginRedirect');
        sessionStorage.removeItem('postLoginRedirect');
        window.location.href = redirectTo || '/dashboard';
      } else if (status === 403 && data.needsVerification) {
        goToVerify(data.verifyToken, data.error);
      } else {
        showError(data.error ? window.tServer(data.error) : window.t('auth.loginFail'));
        resetCaptcha();
      }
    });
  }

  if (verifyForm) {
    const params = new URLSearchParams(window.location.search);
    let token = params.get('token') || '';
    const msg = params.get('msg');

    const descEl = document.getElementById('verify-desc');
    const resendLink = document.getElementById('resend-link');

    if (msg) {
      showError('');
      descEl.removeAttribute('data-i18n');
      descEl.textContent = window.tServer(msg);
    }

    verifyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const code = verifyForm.code.value.trim();

      const { ok, data } = await submitAuth('/api/verify-email', { token, code });
      if (ok) {
        window.location.href = '/login';
      } else {
        showError(data.error ? window.tServer(data.error) : window.t('auth.verifyFail'));
      }
    });

    resendLink.addEventListener('click', async (e) => {
      e.preventDefault();
      showError('');
      const { ok, data } = await submitAuth('/api/resend-code', { token });
      if (ok) {
        token = data.token;
        descEl.removeAttribute('data-i18n');
        descEl.textContent = data.message ? window.tServer(data.message) : window.t('auth.codeSent');
      } else {
        showError(data.error ? window.tServer(data.error) : window.t('auth.resendFail'));
      }
    });
  }

  if (forgotForm) {
    forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errorEl) errorEl.style.color = '';
      showError('');
      const email = forgotForm.email.value.trim();
      const captchaToken = getCaptchaToken();

      const { ok, data } = await submitAuth('/api/forgot-password', { email, captchaToken });
      if (ok) {
        if (errorEl) errorEl.style.color = 'var(--good)';
        showError(data.message || 'Jika email tersebut terdaftar, kami sudah mengirim link reset password ke sana.');
        forgotForm.querySelector('button[type="submit"]').disabled = true;
      } else {
        showError(data.error ? window.tServer(data.error) : 'Gagal mengirim permintaan. Coba lagi.');
        resetCaptcha();
      }
    });
  }

  if (resetForm) {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';

    if (!token) {
      showError('Link reset password tidak valid — token tidak ditemukan.');
      resetForm.querySelector('button[type="submit"]').disabled = true;
    }

    resetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const newPassword = resetForm.newPassword.value;
      const confirmPassword = resetForm.confirmPassword.value;

      if (newPassword !== confirmPassword) {
        showError('Konfirmasi password tidak cocok.');
        return;
      }

      const { ok, data } = await submitAuth('/api/reset-password', { token, newPassword });
      if (ok) {
        window.location.href = '/login';
      } else {
        showError(data.error ? window.tServer(data.error) : 'Gagal mereset password. Coba lagi.');
      }
    });
  }
});
