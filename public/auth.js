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
        goToVerify(data.verifyToken, 'Kode verifikasi telah dikirim ke email kamu.');
      } else {
        showError(data.error || 'Registrasi gagal.');
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
        window.location.href = redirectTo || '/';
      } else if (status === 403 && data.needsVerification) {
        goToVerify(data.verifyToken, data.error);
      } else {
        showError(data.error || 'Login gagal.');
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
      descEl.textContent = msg;
    }

    verifyForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const code = verifyForm.code.value.trim();

      const { ok, data } = await submitAuth('/api/verify-email', { token, code });
      if (ok) {
        window.location.href = '/login';
      } else {
        showError(data.error || 'Verifikasi gagal.');
      }
    });

    resendLink.addEventListener('click', async (e) => {
      e.preventDefault();
      showError('');
      const { ok, data } = await submitAuth('/api/resend-code', { token });
      if (ok) {
        token = data.token;
        descEl.textContent = data.message || 'Kode baru telah dikirim.';
      } else {
        showError(data.error || 'Gagal mengirim ulang kode.');
      }
    });
  }
});
