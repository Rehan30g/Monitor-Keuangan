document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const stateEl = document.getElementById('link-state');
  const btnConfirm = document.getElementById('btn-confirm');
  const visualEl = document.getElementById('link-visual');
  const identityEl = document.getElementById('link-identity');
  const nameEl = document.getElementById('link-name');
  const usernameEl = document.getElementById('link-username');
  const avatarEl = document.getElementById('link-avatar');
  const hintEl = document.getElementById('link-hint');

  function setState(text, mood) {
    stateEl.removeAttribute('data-i18n');
    stateEl.textContent = text;
    stateEl.classList.toggle('is-error', mood === 'error');
    stateEl.classList.toggle('is-success', mood === 'success');
  }

  // ------------------------------------------------------------------
  // Avatar: foto profil, atau identicon abstrak — algoritma sama persis
  // dengan dashboard (script.js) agar user yang sama terlihat sama.
  // ------------------------------------------------------------------
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  function buatIdenticon(seed, size) {
    const hash = hashString(String(seed));
    const warna = cssVar(`--avatar-${(hash % 8) + 1}`);
    const bg = cssVar('--surface-2');
    const cell = size / 5;
    const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': 'Avatar' });
    svg.appendChild(svgEl('rect', { x: 0, y: 0, width: size, height: size, fill: bg }));
    let bit = 8; // bit berbeda dari yang dipakai untuk pilih warna
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        const nyala = (hash >> bit) & 1;
        bit++;
        if (!nyala) continue;
        const kolom = col === 2 ? [2] : [col, 4 - col];
        for (const c of kolom) {
          svg.appendChild(svgEl('rect', { x: c * cell, y: row * cell, width: cell, height: cell, fill: warna }));
        }
      }
    }
    return svg;
  }

  function renderAvatarInto(el, avatarUrl, seed) {
    if (!el) return;
    el.textContent = '';
    if (avatarUrl) {
      const img = document.createElement('img');
      img.src = avatarUrl + (avatarUrl.includes('?') ? '&' : '?') + 'v=' + Date.now();
      img.alt = window.t('avatar.alt');
      el.appendChild(img);
    } else {
      el.appendChild(buatIdenticon(seed, 64));
    }
  }

  // ------------------------------------------------------------------
  // Alur: cek token → cek login → konfirmasi → hasil
  // ------------------------------------------------------------------
  if (!token) {
    setState(window.t('linktg.invalid'), 'error');
    return;
  }

  let me;
  try {
    const meRes = await fetch('/api/me');
    if (!meRes.ok) {
      sessionStorage.setItem('postLoginRedirect', window.location.pathname + window.location.search);
      window.location.href = '/login';
      return;
    }
    me = await meRes.json();
  } catch (err) {
    setState(window.t('linktg.failCheck'), 'error');
    return;
  }

  renderAvatarInto(avatarEl, me.avatarUrl, me.userId || me.username);
  nameEl.textContent = me.displayName || me.username;
  usernameEl.textContent = '@' + me.username;
  identityEl.hidden = false;

  setState(window.t('linktg.confirm'));
  btnConfirm.hidden = false;
  hintEl.hidden = false;

  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    setState(window.t('linktg.connecting'));

    try {
      const response = await fetch('/api/telegram/confirm-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token })
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        setState(data.message ? window.tServer(data.message) : window.t('linktg.success'), 'success');
        btnConfirm.hidden = true;
        hintEl.hidden = true;
        visualEl.classList.add('is-linked');
      } else {
        setState(data.error ? window.tServer(data.error) : window.t('linktg.fail'), 'error');
        btnConfirm.disabled = false;
      }
    } catch (err) {
      setState(window.t('linktg.failNet'), 'error');
      btnConfirm.disabled = false;
    }
  });
});
