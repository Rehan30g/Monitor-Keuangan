document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const stateEl = document.getElementById('link-state');
  const btnConfirm = document.getElementById('btn-confirm');

  if (!token) {
    stateEl.textContent = 'Link tidak valid — token tidak ditemukan.';
    return;
  }

  let username;
  try {
    const meRes = await fetch('/api/me');
    if (!meRes.ok) {
      sessionStorage.setItem('postLoginRedirect', window.location.pathname + window.location.search);
      window.location.href = '/login';
      return;
    }
    const me = await meRes.json();
    username = me.username;
  } catch (err) {
    stateEl.textContent = 'Gagal memeriksa status login.';
    return;
  }

  stateEl.textContent = `Hubungkan chat Telegram ini ke akun "${username}"?`;
  btnConfirm.hidden = false;

  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    stateEl.textContent = 'Menghubungkan...';

    try {
      const response = await fetch('/api/telegram/confirm-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        stateEl.textContent = data.message || 'Berhasil terhubung! Kembali ke Telegram.';
        btnConfirm.hidden = true;
      } else {
        stateEl.textContent = data.error || 'Gagal menghubungkan.';
        btnConfirm.disabled = false;
      }
    } catch (err) {
      stateEl.textContent = 'Gagal menghubungkan ke server.';
      btnConfirm.disabled = false;
    }
  });
});
