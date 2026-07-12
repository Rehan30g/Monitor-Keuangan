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
  const googleUsernameForm = document.getElementById('google-username-form');
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

  // --- "Masuk dengan Google": tampilkan tombol hanya bila server mengaktifkannya
  // (GOOGLE_CLIENT_ID/SECRET ada). Kalau tidak, tombol tetap tersembunyi. ---
  const googleBtn = document.getElementById('google-btn');
  const googleDivider = document.getElementById('google-divider');
  if (googleBtn) {
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (cfg && cfg.googleEnabled) {
          googleBtn.hidden = false;
          if (googleDivider) googleDivider.hidden = false;
        }
      })
      .catch(() => {});
  }

  // Pesan galat dari callback Google (redirect ke /login?googleError=<kode>).
  const GOOGLE_ERR_KEYS = {
    google_state: 'auth.google.err.state',
    google_failed: 'auth.google.err.failed',
    google_no_sub: 'auth.google.err.failed',
    google_email_unverified: 'auth.google.err.unverified',
    link_requires_verified_email: 'auth.google.err.linkVerify',
    account_deleted: 'auth.google.err.deleted'
  };
  const googleErr = new URLSearchParams(window.location.search).get('googleError');
  if (googleErr && errorEl) {
    showError(window.t(GOOGLE_ERR_KEYS[googleErr] || 'auth.google.err.failed'));
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

  // Halaman pemilihan username untuk pendaftaran Google baru. Token pending
  // ada di query (?token=...); username dikirim ke complete-signup. Sukses →
  // sesi sudah terbit (Set-Cookie) → langsung ke dashboard.
  if (googleUsernameForm) {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    if (!token) {
      showError(window.t('auth.googleUsername.noToken'));
      googleUsernameForm.querySelector('button[type="submit"]').disabled = true;
    }

    googleUsernameForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const username = googleUsernameForm.username.value.trim();
      const { ok, data } = await submitAuth('/api/auth/google/complete-signup', { token, username });
      if (ok) {
        window.location.href = data.redirect || '/dashboard';
      } else {
        showError(data.error ? window.tServer(data.error) : window.t('auth.regFail'));
      }
    });
  }

  function finishLogin() {
    const redirectTo = sessionStorage.getItem('postLoginRedirect');
    sessionStorage.removeItem('postLoginRedirect');
    window.location.href = redirectTo || '/dashboard';
  }

  if (loginForm) {
    const mfaForm = document.getElementById('mfa-form');
    const mfaError = document.getElementById('mfa-error');
    const loginContainer = document.getElementById('login-container');
    const mfaContainer = document.getElementById('mfa-container');
    const mfaBack = document.getElementById('mfa-back');
    let mfaChallengeId = null;

    function showMfaError(message) {
      if (mfaError) mfaError.textContent = message;
    }

    // Langkah kedua (kode MFA) tampil sebagai container terpisah dalam alur
    // halaman yang sama, menggantikan kartu login di tempat yang sama —
    // bukan jendela/overlay yang melayang di atasnya.
    function showMfaStep(challengeId) {
      mfaChallengeId = challengeId;
      showMfaError('');
      if (loginContainer) loginContainer.hidden = true;
      if (mfaContainer) mfaContainer.hidden = false;
      const codeInput = document.getElementById('mfa-code');
      if (codeInput) {
        codeInput.value = '';
        codeInput.focus();
      }
    }

    function backToLogin() {
      if (mfaContainer) mfaContainer.hidden = true;
      if (loginContainer) loginContainer.hidden = false;
    }

    if (mfaBack) {
      mfaBack.addEventListener('click', (e) => {
        e.preventDefault();
        backToLogin();
      });
    }

    // Alur Google + MFA: callback mengarahkan ke /login?mfaChallenge=<id> untuk
    // akun ber-MFA. Tampilkan langsung langkah MFA; POST /api/login/mfa menerbitkan sesi.
    const pendingChallenge = new URLSearchParams(window.location.search).get('mfaChallenge');
    if (pendingChallenge && mfaContainer) {
      showMfaStep(pendingChallenge);
      history.replaceState(null, '', window.location.pathname);
    }

    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      const username = loginForm.username.value.trim();
      const password = loginForm.password.value;
      const captchaToken = getCaptchaToken();

      const { ok, status, data } = await submitAuth('/api/login', { username, password, captchaToken });
      if (ok && data.mfaRequired) {
        showMfaStep(data.challengeId);
      } else if (ok) {
        finishLogin();
      } else if (status === 403 && data.needsVerification) {
        goToVerify(data.verifyToken, data.error);
      } else {
        showError(data.error ? window.tServer(data.error) : window.t('auth.loginFail'));
        resetCaptcha();
      }
    });

    if (mfaForm) {
      mfaForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showMfaError('');
        const code = document.getElementById('mfa-code').value.trim();
        const { ok, data } = await submitAuth('/api/login/mfa', { challengeId: mfaChallengeId, code });
        if (ok) {
          finishLogin();
        } else {
          showMfaError(data.error ? window.tServer(data.error) : window.t('auth.mfaFail'));
        }
      });
    }
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
