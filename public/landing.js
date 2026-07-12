document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/api/me');
    const loggedIn = response.ok;
    document.querySelectorAll('.guest-only').forEach((el) => { el.hidden = loggedIn; });
    document.querySelectorAll('.auth-only').forEach((el) => { el.hidden = !loggedIn; });
  } catch (err) {
    console.error('Gagal memeriksa status login:', err);
  }
});
