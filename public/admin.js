// Panel admin. Guard klien (redirect bila tak login / bukan admin), lalu
// render daftar pengguna + aksi. Kontrol akses sesungguhnya ada di server pada
// setiap /api/admin/* — halaman ini hanya UI.
document.addEventListener('DOMContentLoaded', () => {
  const t = window.t;
  const usersCard = document.getElementById('admin-users-card');
  const usersBody = document.getElementById('admin-users-body');
  const inlineMsg = document.getElementById('admin-inline-msg');
  const inlineText = document.getElementById('admin-inline-text');
  const toast = document.getElementById('admin-toast');
  const deletedCard = document.getElementById('admin-deleted-card');
  const deletedBody = document.getElementById('admin-deleted-body');
  const deletedScroll = document.getElementById('admin-deleted-scroll');
  const deletedEmpty = document.getElementById('admin-deleted-empty');

  let selectedUser = null; // { id, username, role, ... } dari baris yang dibuka
  let selectedDeleted = null; // akun terhapus yang dipilih untuk dipulihkan

  // ------------------------------------------------------------------
  // Modal (.cf-sheet) — pola buka/tutup sama seperti dashboard (script.js).
  // ------------------------------------------------------------------
  const cfOverlay = document.getElementById('cf-overlay');
  let cfAktif = null;
  let cfTimer = null;
  let cfFokusAsal = null;

  function bukaKonfirmasi(id) {
    tutupKonfirmasi(false);
    clearTimeout(cfTimer);
    const sheet = document.getElementById(id);
    if (!sheet) return;
    cfAktif = sheet;
    cfFokusAsal = document.activeElement;
    cfOverlay.hidden = false;
    sheet.hidden = false;
    void sheet.offsetHeight;
    cfOverlay.classList.add('is-open');
    sheet.classList.add('is-open');
    document.documentElement.classList.add('tx-modal-open');
  }

  function tutupKonfirmasi(kembalikanFokus) {
    if (!cfAktif) return;
    const sheet = cfAktif;
    cfAktif = null;
    cfOverlay.classList.remove('is-open');
    sheet.classList.remove('is-open');
    document.documentElement.classList.remove('tx-modal-open');
    clearTimeout(cfTimer);
    cfTimer = setTimeout(() => {
      cfOverlay.hidden = true;
      sheet.hidden = true;
    }, 240);
    if (kembalikanFokus !== false && cfFokusAsal && cfFokusAsal.focus) cfFokusAsal.focus();
    cfFokusAsal = null;
  }

  cfOverlay.addEventListener('click', () => tutupKonfirmasi());
  document.querySelectorAll('[data-cf-close]').forEach((btn) => {
    btn.addEventListener('click', () => tutupKonfirmasi());
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') tutupKonfirmasi();
  });

  // ------------------------------------------------------------------
  // Util
  // ------------------------------------------------------------------
  function fmtDate(val) {
    if (!val) return '-';
    const d = new Date(val);
    if (isNaN(d.getTime())) return '-';
    const lang = window.getLang ? window.getLang() : 'id';
    const locale = lang === 'zh' ? 'zh-CN' : lang === 'en' ? 'en-US' : 'id-ID';
    return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function showToast(text, ok) {
    toast.textContent = text;
    toast.className = 'form-msg ' + (ok ? 'is-success' : 'is-error');
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') node.className = props[k];
      else if (k === 'text') node.textContent = props[k];
      else node.setAttribute(k, props[k]);
    }
    if (children) for (const c of children) node.appendChild(c);
    return node;
  }

  // ------------------------------------------------------------------
  // Render tabel pengguna
  // ------------------------------------------------------------------
  function rolePill(role, deleted) {
    if (deleted) return el('span', { class: 'admin-pill is-deleted', text: t('admin.deleted') });
    if (role === 'admin') return el('span', { class: 'admin-pill is-admin', text: t('admin.roleAdmin') });
    return el('span', { class: 'admin-pill', text: t('admin.roleUser') });
  }

  function yesNo(flag) {
    return el('span', {
      class: flag ? 'admin-yes' : 'admin-no',
      text: flag ? t('admin.yes') : t('admin.no')
    });
  }

  function renderUsers(users) {
    usersBody.textContent = '';
    for (const u of users) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: u.username }));
      tr.appendChild(el('td', { text: u.email }));
      tr.appendChild(el('td', null, [rolePill(u.role, u.deleted)]));
      tr.appendChild(el('td', { class: 'admin-mono', text: fmtDate(u.createdAt) }));
      tr.appendChild(el('td', null, [yesNo(Boolean(u.emailVerified))]));
      tr.appendChild(el('td', null, [yesNo(Boolean(u.mfaEnabled))]));
      tr.appendChild(el('td', {
        class: 'admin-mono',
        text: u.lastLoginAt ? fmtDate(u.lastLoginAt) : t('admin.never')
      }));
      const btn = el('button', { class: 'btn-secondary admin-row-btn', text: t('admin.detail') });
      btn.addEventListener('click', () => openDetail(u));
      tr.appendChild(el('td', null, [btn]));
      usersBody.appendChild(tr);
    }
    usersCard.hidden = false;
  }

  // ------------------------------------------------------------------
  // Akun terhapus (masih bisa dipulihkan)
  // ------------------------------------------------------------------
  function renderDeleted(accounts) {
    deletedBody.textContent = '';
    if (!accounts || accounts.length === 0) {
      deletedScroll.hidden = true;
      deletedEmpty.hidden = false;
      deletedCard.hidden = false;
      return;
    }
    for (const a of accounts) {
      const tr = el('tr');
      tr.appendChild(el('td', { text: a.username }));
      tr.appendChild(el('td', { text: a.email }));
      tr.appendChild(el('td', { class: 'admin-mono', text: fmtDate(a.deletedAt) }));
      tr.appendChild(el('td', { text: t('admin.daysLeft', { n: a.daysRemaining }) }));
      const btn = el('button', { class: 'btn-secondary admin-row-btn', text: t('admin.restore') });
      btn.addEventListener('click', () => openRestore(a));
      tr.appendChild(el('td', null, [btn]));
      deletedBody.appendChild(tr);
    }
    deletedEmpty.hidden = true;
    deletedScroll.hidden = false;
    deletedCard.hidden = false;
  }

  function openRestore(account) {
    selectedDeleted = account;
    document.getElementById('cf-restore-msg-text').textContent =
      t('admin.restoreMsg', { u: account.username });
    document.getElementById('cf-restore-msg').textContent = '';
    bukaKonfirmasi('cf-restore');
  }

  async function loadDeleted() {
    let res;
    try {
      res = await fetch('/api/admin/deleted-users', { credentials: 'same-origin' });
    } catch (err) {
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    renderDeleted(data.accounts || []);
  }

  document.getElementById('btn-restore-confirm').addEventListener('click', async () => {
    if (!selectedDeleted) return;
    const msgEl = document.getElementById('cf-restore-msg');
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(selectedDeleted.id) + '/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        tutupKonfirmasi();
        showToast(t('admin.restoreSuccess'), true);
        // Akun kembali normal: hilang dari daftar terhapus, muncul lagi di daftar utama.
        loadUsers();
        loadDeleted();
      } else {
        msgEl.className = 'form-msg is-error';
        msgEl.textContent = data.error ? window.tServer(data.error) : t('admin.actionFail');
      }
    } catch (err) {
      msgEl.className = 'form-msg is-error';
      msgEl.textContent = t('admin.actionFail');
    }
  });

  // ------------------------------------------------------------------
  // Detail pengguna
  // ------------------------------------------------------------------
  function historyBlock(titleKey, items, renderItem) {
    const block = el('div', { class: 'admin-detail-block' });
    block.appendChild(el('h4', { text: t(titleKey) }));
    const ul = el('ul');
    if (!items || items.length === 0) {
      ul.appendChild(el('li', { text: t('admin.noneYet') }));
    } else {
      for (const it of items) ul.appendChild(el('li', { text: renderItem(it) }));
    }
    block.appendChild(ul);
    return block;
  }

  function pwViaLabel(via) {
    if (via === 'self') return t('admin.viaSelf');
    if (via === 'reset') return t('admin.viaReset');
    if (via === 'admin_reset') return t('admin.viaAdminReset');
    return via;
  }

  async function openDetail(rowUser) {
    selectedUser = rowUser;
    const body = document.getElementById('cf-detail-body');
    body.textContent = '';
    body.appendChild(el('p', { class: 'cf-desc', text: t('admin.loading') }));
    bukaKonfirmasi('cf-detail');

    let detail;
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(rowUser.id));
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      detail = data.user;
    } catch (err) {
      body.textContent = '';
      body.appendChild(el('p', { class: 'cf-desc', text: t('admin.loadFail') }));
      return;
    }
    selectedUser = detail;

    body.textContent = '';
    // Ringkasan
    const summary = el('div', { class: 'admin-detail-block' });
    summary.appendChild(el('h4', { text: '@' + detail.username }));
    const sul = el('ul');
    sul.appendChild(el('li', { text: t('admin.thEmail') + ': ' + detail.email }));
    sul.appendChild(el('li', { text: t('admin.thRole') + ': ' + (detail.role === 'admin' ? t('admin.roleAdmin') : t('admin.roleUser')) }));
    sul.appendChild(el('li', { text: t('admin.thVerified') + ': ' + (detail.emailVerified ? t('admin.yes') : t('admin.no')) }));
    sul.appendChild(el('li', { text: t('admin.thMfa') + ': ' + (detail.mfaEnabled ? t('admin.yes') : t('admin.no')) }));
    sul.appendChild(el('li', { text: 'Plan: ' + (detail.subscription ? detail.subscription.toUpperCase() : 'FREE') }));
    sul.appendChild(el('li', { text: t('admin.thCreated') + ': ' + fmtDate(detail.createdAt) }));
    if (detail.deleted) sul.appendChild(el('li', { text: t('admin.deleted') }));
    summary.appendChild(sul);
    body.appendChild(summary);

    body.appendChild(historyBlock('admin.emailHistory', detail.emailHistory,
      (h) => fmtDate(h.changedAt) + ' · ' + h.oldEmail));
    body.appendChild(historyBlock('admin.passwordLog', detail.passwordChanges,
      (p) => fmtDate(p.changedAt) + ' · ' + pwViaLabel(p.changedVia)));
    body.appendChild(historyBlock('admin.loginHistory', detail.loginHistory,
      (l) => fmtDate(l.occurredAt) + ' · ' + (l.success ? t('admin.loginOk') : t('admin.loginFail')) +
        (l.ip ? ' · ' + l.ip : '')));
    body.appendChild(historyBlock('admin.connectedApps', detail.connectedApps,
      (a) => (a.clientName || a.clientId) + ' · ' + fmtDate(a.connectedSince)));

    // Tombol role menyesuaikan status saat ini
    const roleBtn = document.getElementById('btn-detail-role');
    roleBtn.textContent = detail.role === 'admin' ? t('admin.revokeAdmin') : t('admin.makeAdmin');

    // Bagian audit transaksi + rollback (dimuat terpisah).
    body.appendChild(renderTxAuditSection(detail));
    loadTxSessions(detail.id);
  }

  // ------------------------------------------------------------------
  // Audit transaksi + rollback
  // ------------------------------------------------------------------
  let pendingRollback = null; // { userId, username, criteria }

  // Format sessionLabel mentah menjadi label yang mudah dibaca.
  function fmtSessionLabel(label) {
    if (!label) return t('admin.txSrcUnknown');
    if (label.indexOf('telegram:') === 0) return t('admin.txSrcTelegram');
    if (label === 'mcp:pat') return t('admin.txSrcMcpPat');
    if (label.indexOf('mcp:') === 0) return t('admin.txSrcMcpOauth');
    // Anggap sisanya session cookie (sid) web — potong supaya tidak membocorkan penuh.
    const short = label.length > 8 ? label.slice(0, 8) + '…' : label;
    return t('admin.txSrcWeb', { s: short });
  }

  function renderTxAuditSection(detail) {
    const block = el('div', { class: 'admin-detail-block' });
    block.appendChild(el('h4', { text: t('admin.txAuditTitle') }));
    block.appendChild(el('p', { class: 'admin-tx-meta', text: t('admin.txAuditDesc') }));

    const list = el('ul', { class: 'admin-tx-sessions' });
    list.id = 'tx-sessions-list';
    list.appendChild(el('li', { text: t('admin.loading') }));
    block.appendChild(list);

    // Picker rentang waktu manual.
    block.appendChild(el('h4', { text: t('admin.txRangeTitle'), style: 'margin-top:14px' }));
    const range = el('div', { class: 'admin-tx-range' });
    const fromLabel = el('label', { text: t('admin.txRangeFrom') });
    const fromInput = el('input', { type: 'datetime-local' });
    fromInput.id = 'tx-range-from';
    fromLabel.appendChild(fromInput);
    const toLabel = el('label', { text: t('admin.txRangeTo') });
    const toInput = el('input', { type: 'datetime-local' });
    toInput.id = 'tx-range-to';
    toLabel.appendChild(toInput);
    const rangeBtn = el('button', { class: 'btn-secondary admin-row-btn', text: t('admin.txRangeBtn') });
    rangeBtn.addEventListener('click', () => {
      const fromMs = fromInput.value ? new Date(fromInput.value).getTime() : NaN;
      const toMs = toInput.value ? new Date(toInput.value).getTime() : NaN;
      if (isNaN(fromMs) || isNaN(toMs) || fromMs > toMs) {
        showToast(t('admin.txRangeInvalid'), false);
        return;
      }
      startRollback(detail, { fromTime: fromMs, toTime: toMs });
    });
    range.appendChild(fromLabel);
    range.appendChild(toLabel);
    range.appendChild(rangeBtn);
    block.appendChild(range);
    return block;
  }

  async function loadTxSessions(userId) {
    const list = document.getElementById('tx-sessions-list');
    if (!list) return;
    let sessions = [];
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(userId) + '/tx-sessions', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      sessions = data.sessions || [];
    } catch (err) {
      list.textContent = '';
      list.appendChild(el('li', { text: t('admin.loadFail') }));
      return;
    }
    list.textContent = '';
    if (sessions.length === 0) {
      list.appendChild(el('li', { text: t('admin.txNoSessions') }));
      return;
    }
    for (const s of sessions) {
      const li = el('li');
      li.appendChild(el('span', { class: 'admin-tx-src', text: fmtSessionLabel(s.sessionLabel) }));
      li.appendChild(el('span', {
        class: 'admin-tx-meta',
        text: fmtDate(s.firstAt) + ' → ' + fmtDate(s.lastAt) + ' · +' + s.addCount + ' / −' + s.deleteCount
      }));
      li.appendChild(el('span', { class: 'admin-tx-spacer' }));
      const btn = el('button', { class: 'btn-secondary admin-row-btn', text: t('admin.txRollbackSession') });
      const label = s.sessionLabel;
      btn.addEventListener('click', () => startRollback({ id: userId, username: selectedUser ? selectedUser.username : '' }, { sessionLabel: label }));
      li.appendChild(btn);
      list.appendChild(li);
    }
  }

  // Panggil preview lalu tampilkan sheet konfirmasi berisi ringkasan.
  async function startRollback(user, criteria) {
    let preview;
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(user.id) + '/tx-rollback/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(criteria)
      });
      if (!res.ok) throw new Error('http ' + res.status);
      preview = await res.json();
    } catch (err) {
      showToast(t('admin.txPreviewFail'), false);
      return;
    }

    pendingRollback = { userId: user.id, username: user.username, criteria };

    const bodyEl = document.getElementById('cf-txrollback-body');
    bodyEl.textContent = '';
    bodyEl.appendChild(el('p', { class: 'cf-desc', text: t('admin.txConfirmIntro', { u: user.username || '' }) }));
    const restoreN = (preview.toRestore || []).length;
    const removeN = (preview.toRemove || []).length;
    const ul = el('ul');
    ul.appendChild(el('li', { text: t('admin.txWillRestore', { n: restoreN }) }));
    ul.appendChild(el('li', { text: t('admin.txWillRemove', { n: removeN }) }));
    bodyEl.appendChild(ul);
    if (restoreN === 0 && removeN === 0) {
      bodyEl.appendChild(el('p', { class: 'cf-desc', text: t('admin.txNothing') }));
    } else {
      const names = [];
      for (const r of (preview.toRestore || [])) if (r && r.keterangan) names.push('+ ' + r.keterangan);
      for (const r of (preview.toRemove || [])) if (r && r.snapshot && r.snapshot.keterangan) names.push('− ' + r.snapshot.keterangan);
      if (names.length) {
        const nul = el('ul');
        for (const n of names.slice(0, 12)) nul.appendChild(el('li', { text: n }));
        bodyEl.appendChild(nul);
      }
    }
    document.getElementById('cf-txrollback-msg').textContent = '';
    bukaKonfirmasi('cf-txrollback');
  }

  document.getElementById('btn-txrollback-confirm').addEventListener('click', async () => {
    if (!pendingRollback) return;
    const msgEl = document.getElementById('cf-txrollback-msg');
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(pendingRollback.userId) + '/tx-rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(pendingRollback.criteria)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        tutupKonfirmasi();
        showToast(t('admin.txDone', { r: data.restored || 0, d: data.removed || 0 }), true);
        // Segarkan detail (termasuk daftar sesi) untuk user yang sama.
        openDetail({ id: pendingRollback.userId, username: pendingRollback.username });
        pendingRollback = null;
      } else {
        msgEl.className = 'form-msg is-error';
        msgEl.textContent = data.error ? window.tServer(data.error) : t('admin.actionFail');
      }
    } catch (err) {
      msgEl.className = 'form-msg is-error';
      msgEl.textContent = t('admin.actionFail');
    }
  });

  // ------------------------------------------------------------------
  // Aksi: reset password
  // ------------------------------------------------------------------
  document.getElementById('btn-detail-reset').addEventListener('click', () => {
    document.getElementById('cf-reset-msg').textContent = '';
    bukaKonfirmasi('cf-reset');
  });

  document.getElementById('btn-reset-confirm').addEventListener('click', async () => {
    if (!selectedUser) return;
    const msgEl = document.getElementById('cf-reset-msg');
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(selectedUser.id) + '/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        tutupKonfirmasi();
        showToast(t('admin.resetSuccess'), true);
      } else {
        msgEl.className = 'form-msg is-error';
        msgEl.textContent = data.error ? window.tServer(data.error) : t('admin.actionFail');
      }
    } catch (err) {
      msgEl.className = 'form-msg is-error';
      msgEl.textContent = t('admin.actionFail');
    }
  });

  // ------------------------------------------------------------------
  // Aksi: ubah role
  // ------------------------------------------------------------------
  document.getElementById('btn-detail-role').addEventListener('click', () => {
    if (!selectedUser) return;
    const toAdmin = selectedUser.role !== 'admin';
    document.getElementById('cf-role-msg-text').textContent =
      toAdmin ? t('admin.roleMsgMake', { u: selectedUser.username })
              : t('admin.roleMsgRevoke', { u: selectedUser.username });
    document.getElementById('cf-role-msg').textContent = '';
    bukaKonfirmasi('cf-role');
  });

  document.getElementById('btn-role-confirm').addEventListener('click', async () => {
    if (!selectedUser) return;
    const newRole = selectedUser.role === 'admin' ? 'user' : 'admin';
    const msgEl = document.getElementById('cf-role-msg');
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(selectedUser.id) + '/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ role: newRole })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        tutupKonfirmasi();
        showToast(t('admin.roleSuccess'), true);
        loadUsers();
      } else if (data.reason === 'last_admin') {
        msgEl.className = 'form-msg is-error';
        msgEl.textContent = t('admin.lastAdminErr');
      } else {
        msgEl.className = 'form-msg is-error';
        msgEl.textContent = data.error ? window.tServer(data.error) : t('admin.actionFail');
      }
    } catch (err) {
      msgEl.className = 'form-msg is-error';
      msgEl.textContent = t('admin.actionFail');
    }
  });

  // ------------------------------------------------------------------
  // Aksi: reset cooldown ganti username
  // ------------------------------------------------------------------
  document.getElementById('btn-detail-username-cd').addEventListener('click', () => {
    if (!selectedUser) return;
    document.getElementById('cf-username-cd-msg-text').textContent =
      t('admin.usernameCdConfirmMsg', { u: selectedUser.username });
    document.getElementById('cf-username-cd-msg').textContent = '';
    bukaKonfirmasi('cf-username-cd');
  });

  document.getElementById('btn-username-cd-confirm').addEventListener('click', async () => {
    if (!selectedUser) return;
    const msgEl = document.getElementById('cf-username-cd-msg');
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(selectedUser.id) + '/reset-username-cooldown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        tutupKonfirmasi();
        showToast(t('admin.usernameCdSuccess'), true);
      } else {
        msgEl.className = 'form-msg is-error';
        msgEl.textContent = data.error ? window.tServer(data.error) : t('admin.actionFail');
      }
    } catch (err) {
      msgEl.className = 'form-msg is-error';
      msgEl.textContent = t('admin.actionFail');
    }
  });

  // ------------------------------------------------------------------
  // Aksi: ubah subscription plan
  // ------------------------------------------------------------------
  document.getElementById('btn-detail-subscription').addEventListener('click', async () => {
    if (!selectedUser) return;
    const plans = ['free', 'lite', 'pro', 'max'];
    const current = selectedUser.subscription || 'free';
    const choice = prompt('Set subscription plan for @' + selectedUser.username + ' (free, lite, pro, max):', current);
    if (choice === null) return;
    const plan = choice.toLowerCase().trim();
    if (!plans.includes(plan)) {
      alert('Plan tidak valid! Pilih free, lite, pro, atau max.');
      return;
    }
    
    try {
      const res = await fetch('/api/admin/users/' + encodeURIComponent(selectedUser.id) + '/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: plan }),
        credentials: 'same-origin'
      });
      if (res.ok) {
        alert('Plan untuk @' + selectedUser.username + ' berhasil diubah menjadi ' + plan.toUpperCase() + '!');
        tutupKonfirmasi();
        loadUsers();
      } else {
        alert('Gagal mengubah plan.');
      }
    } catch (err) {
      console.error(err);
      alert('Terjadi kesalahan koneksi.');
    }
  });

  // ------------------------------------------------------------------
  // Muat data (dengan guard akses)
  // ------------------------------------------------------------------
  function showInline(text) {
    inlineText.textContent = text;
    inlineMsg.hidden = false;
    usersCard.hidden = true;
    deletedCard.hidden = true;
  }

  async function loadUsers() {
    let res;
    try {
      res = await fetch('/api/admin/users', { credentials: 'same-origin' });
    } catch (err) {
      showInline(t('admin.loadFail'));
      return;
    }
    if (res.status === 401) {
      sessionStorage.setItem('postLoginRedirect', '/admin');
      window.location.href = '/login?returnTo=/admin';
      return;
    }
    if (res.status === 403) {
      const data = await res.json().catch(() => ({}));
      if (data.reason === 'mfa_required') {
        showInline(t('admin.needMfa'));
      } else {
        window.location.href = '/dashboard';
      }
      return;
    }
    if (!res.ok) {
      showInline(t('admin.loadFail'));
      return;
    }
    const data = await res.json();
    inlineMsg.hidden = true;
    renderUsers(data.users || []);
    loadDeleted();
  }

  async function init() {
    // Guard login lebih dulu (pola link-telegram.js).
    let me;
    try {
      const meRes = await fetch('/api/me', { credentials: 'same-origin' });
      if (!meRes.ok) {
        sessionStorage.setItem('postLoginRedirect', '/admin');
        window.location.href = '/login?returnTo=/admin';
        return;
      }
      me = await meRes.json();
    } catch (err) {
      window.location.href = '/login';
      return;
    }
    // Fast-path: non-admin langsung ke dashboard (server tetap otoritatif).
    if (me.role !== 'admin') {
      window.location.href = '/dashboard';
      return;
    }
    loadUsers();
  }

  init();
  window.addEventListener('langchange', () => { if (!usersCard.hidden) loadUsers(); });
});
