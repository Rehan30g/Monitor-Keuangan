document.addEventListener('DOMContentLoaded', () => {
  const pesanError = document.getElementById('pesan-error');
  const tabelBody = document.getElementById('tabel-body');
  const formTransaksi = document.getElementById('form-transaksi');
  const txSearch = document.getElementById('tx-search');
  const txCount = document.getElementById('tx-count');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Nama bulan mengikuti bahasa aktif (i18n.js).
  const namaBulan = () => window.tMonths();

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let appData = null;          // hasil GET /api/transactions
  let filterJenis = 'semua';
  let searchQuery = '';
  let activeTab = 'ringkasan';

  // ------------------------------------------------------------------
  // Util
  // ------------------------------------------------------------------
  function formatRupiah(angka) {
    const tanda = angka < 0 ? '-' : '';
    const abs = Math.abs(Math.floor(angka));
    return `${tanda}Rp ${String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
  }

  // Angka ringkas untuk sumbu, per bahasa: id 1,5 jt / en 1.5M / zh 150 万
  function angkaRingkas(n) {
    const abs = Math.abs(n);
    const lang = window.getLang();
    const fmt = (v, suffix) => {
      let s = (Math.round(v * 10) / 10).toString();
      if (lang === 'id') s = s.replace('.', ',');
      return (n < 0 ? '-' : '') + s + suffix;
    };
    if (lang === 'zh') {
      if (abs >= 1e8) return fmt(abs / 1e8, ' 亿');
      if (abs >= 1e4) return fmt(abs / 1e4, ' 万');
      return String(n);
    }
    const suf = lang === 'en' ? ['K', 'M', 'B'] : [' rb', ' jt', ' M'];
    if (abs >= 1e9) return fmt(abs / 1e9, suf[2]);
    if (abs >= 1e6) return fmt(abs / 1e6, suf[1]);
    if (abs >= 1e3) return fmt(abs / 1e3, suf[0]);
    return String(n);
  }

  // waktu = "YYYY-MM-DD HH:MM:SS"
  function tanggalPendek(waktu) {
    const d = waktu.slice(0, 10).split('-'); // [Y, M, D]
    return `${parseInt(d[2], 10)} ${namaBulan()[parseInt(d[1], 10) - 1]}`;
  }
  function bulanLabel(ym) { // "YYYY-MM"
    const [y, m] = ym.split('-');
    return `${namaBulan()[parseInt(m, 10) - 1]} ${y}`;
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  // Skala tick "bersih": langkah 1/2/5 × 10^k, maksimal ~4 tick
  function skalaTick(maxValue) {
    if (maxValue <= 0) return { max: 1, ticks: [0, 1] };
    const targetStep = maxValue / 3;
    const pow = Math.pow(10, Math.floor(Math.log10(targetStep)));
    let step = pow;
    for (const m of [1, 2, 5, 10]) {
      if (pow * m >= targetStep) { step = pow * m; break; }
    }
    const max = Math.ceil(maxValue / step) * step;
    const ticks = [];
    for (let v = 0; v <= max + step / 2; v += step) ticks.push(v);
    return { max, ticks };
  }

  // Masking email murni sisi klien: 2 karakter pertama + "**" + @domain.
  // "rehanchristian30@gmail.com" → "re**@gmail.com". Email asli tak pernah
  // dirender ke UI.
  function maskEmail(email) {
    if (typeof email !== 'string' || !email) return '';
    const at = email.indexOf('@');
    if (at <= 0) return '**';
    return email.slice(0, Math.min(2, at)) + '**' + email.slice(at);
  }

  function tampilkanEmail(email) {
    document.getElementById('setting-email').textContent = maskEmail(email) || '–';
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ------------------------------------------------------------------
  // Avatar: foto profil, atau identicon abstrak (simetris, khas tiap akun)
  // ------------------------------------------------------------------
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

  function renderSemuaAvatar(avatarUrl, seed) {
    ['avatar-sidebar', 'avatar-mobile', 'avatar-settings'].forEach((id) => {
      renderAvatarInto(document.getElementById(id), avatarUrl, seed);
    });
    const btnHapus = document.getElementById('btn-avatar-hapus');
    if (btnHapus) btnHapus.hidden = !avatarUrl;
  }

  // Tooltip bersama per chart-wrap
  function buatTooltip(wrap) {
    let tip = wrap.querySelector('.chart-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tooltip';
      tip.hidden = true;
      wrap.appendChild(tip);
    }
    return tip;
  }

  function isiTooltip(tip, judul, baris) {
    tip.textContent = '';
    const t = document.createElement('div');
    t.className = 'tt-title';
    t.textContent = judul;
    tip.appendChild(t);
    for (const b of baris) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      if (b.warna) {
        const key = document.createElement('span');
        key.className = 'tt-key';
        key.style.background = b.warna;
        row.appendChild(key);
      }
      const val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = b.nilai;
      row.appendChild(val);
      if (b.label) {
        const lab = document.createElement('span');
        lab.textContent = b.label;
        row.appendChild(lab);
      }
      tip.appendChild(row);
    }
  }

  function posisikanTooltip(tip, wrap, x, y) {
    const w = wrap.clientWidth;
    tip.style.left = Math.max(60, Math.min(w - 60, x)) + 'px';
    tip.style.top = Math.max(34, y) + 'px';
    tip.hidden = false;
  }

  // ------------------------------------------------------------------
  // Navigasi tab
  // ------------------------------------------------------------------
  const navButtons = document.querySelectorAll('.nav-item[data-tab]');
  const FAB_TABS = ['ringkasan', 'transaksi', 'laporan']; // FAB tampil di tab ini saja
  function bukaTab(nama) {
    activeTab = nama;
    document.querySelectorAll('.tab').forEach((sec) => {
      sec.classList.toggle('is-active', sec.id === `tab-${nama}`);
    });
    navButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === nama);
    });
    // FAB hidup di luar .tab; tampil hanya di tab yang relevan.
    const tampilkanFab = FAB_TABS.includes(nama);
    fabTambah.hidden = !tampilkanFab;
    if (!tampilkanFab) tutupSheet(false); // tutup panel bila pindah ke Pengaturan
    // Chart di tab tersembunyi berukuran 0 — render ulang saat tab dibuka.
    if (appData) renderCharts();
  }
  navButtons.forEach((btn) => btn.addEventListener('click', () => bukaTab(btn.dataset.tab)));

  document.getElementById('link-semua-transaksi').addEventListener('click', (e) => {
    e.preventDefault();
    bukaTab('transaksi');
  });

  // ------------------------------------------------------------------
  // Tema
  // ------------------------------------------------------------------
  const themeButtons = document.querySelectorAll('[data-theme-choice]');
  function temaTersimpan() {
    try {
      const t = localStorage.getItem('theme');
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch (e) { return 'system'; }
  }
  function terapkanTema(pilihan) {
    if (pilihan === 'light' || pilihan === 'dark') {
      document.documentElement.setAttribute('data-theme', pilihan);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      if (pilihan === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', pilihan);
    } catch (e) { /* localStorage tidak tersedia */ }
    themeButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.themeChoice === pilihan));
    if (window.terapkanThemeColor) window.terapkanThemeColor(pilihan); // warna bar atas/bawah HP
    if (appData) renderCharts(); // warna chart dibaca dari CSS variables
  }
  themeButtons.forEach((b) => b.addEventListener('click', () => terapkanTema(b.dataset.themeChoice)));
  themeButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.themeChoice === temaTersimpan()));
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (temaTersimpan() === 'system' && appData) renderCharts();
    });
  }

  // ------------------------------------------------------------------
  // Agregasi klien dari data transaksi
  // ------------------------------------------------------------------
  function urutNaik(transaksi) {
    // API mengurut DESC berdasarkan id; balikkan untuk kronologis.
    return transaksi.slice().reverse();
  }

  function seriSaldoHarian(transaksi) {
    // [{tanggal:"YYYY-MM-DD", saldo:number}] kumulatif per hari
    const naik = urutNaik(transaksi);
    const perHari = new Map();
    let saldo = 0;
    for (const t of naik) {
      saldo += t.jenis === 'masuk' ? t.jumlah : -t.jumlah;
      perHari.set(t.waktu.slice(0, 10), saldo);
    }
    return Array.from(perHari, ([tanggal, s]) => ({ tanggal, saldo: s }));
  }

  function rekapBulanan(transaksi) {
    // [{bulan:"YYYY-MM", masuk, keluar}] kronologis
    const peta = new Map();
    for (const t of urutNaik(transaksi)) {
      const ym = t.waktu.slice(0, 7);
      if (!peta.has(ym)) peta.set(ym, { bulan: ym, masuk: 0, keluar: 0 });
      const r = peta.get(ym);
      if (t.jenis === 'masuk') r.masuk += t.jumlah;
      else r.keluar += t.jumlah;
    }
    return Array.from(peta.values()).sort((a, b) => a.bulan < b.bulan ? -1 : 1);
  }

  // ------------------------------------------------------------------
  // Render: statistik & daftar
  // ------------------------------------------------------------------
  function renderStats(data) {
    document.getElementById('ringkasan-saldo').textContent = data.ringkasan.saldo;
    document.getElementById('ringkasan-masuk').textContent = data.ringkasan.pemasukan;
    document.getElementById('ringkasan-keluar').textContent = data.ringkasan.pengeluaran;

    const nMasuk = data.transaksi.filter((t) => t.jenis === 'masuk').length;
    const nKeluar = data.transaksi.length - nMasuk;
    document.getElementById('saldo-sub').textContent = window.t('stat.txRecorded', { n: data.transaksi.length });
    document.getElementById('masuk-sub').textContent = window.t('stat.txCount', { n: nMasuk });
    document.getElementById('keluar-sub').textContent = window.t('stat.txCount', { n: nKeluar });
    document.getElementById('setting-tx-count').textContent = String(data.transaksi.length);
  }

  function renderRecent(data) {
    const list = document.getElementById('recent-list');
    list.textContent = '';
    const terbaru = data.transaksi.slice(0, 5);
    if (terbaru.length === 0) {
      const li = document.createElement('li');
      li.className = 'kosong';
      li.textContent = window.t('empty.tx');
      list.appendChild(li);
      return;
    }
    for (const t of terbaru) {
      const li = document.createElement('li');
      const main = document.createElement('div');
      main.className = 'recent-main';
      const ket = document.createElement('span');
      ket.className = 'recent-ket';
      ket.textContent = t.keterangan;
      const waktu = document.createElement('span');
      waktu.className = 'recent-waktu';
      waktu.textContent = t.waktu;
      main.appendChild(ket);
      main.appendChild(waktu);
      const amount = document.createElement('span');
      amount.className = 'recent-amount ' + (t.jenis === 'masuk' ? 'amount-in' : 'amount-out');
      amount.textContent = (t.jenis === 'masuk' ? '+' : '−') + t.jumlah_format;
      li.appendChild(main);
      li.appendChild(amount);
      list.appendChild(li);
    }
  }

  function renderTable(data) {
    const q = searchQuery.trim().toLowerCase();
    const rows = data.transaksi.filter((t) => {
      if (filterJenis !== 'semua' && t.jenis !== filterJenis) return false;
      if (q && !t.keterangan.toLowerCase().includes(q)) return false;
      return true;
    });

    txCount.textContent = q || filterJenis !== 'semua'
      ? window.t('tx.countFiltered', { shown: rows.length, total: data.transaksi.length })
      : window.t('stat.txCount', { n: data.transaksi.length });

    tabelBody.textContent = '';
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'kosong';
      td.textContent = data.transaksi.length === 0
        ? window.t('empty.txAdd')
        : window.t('empty.filter');
      tr.appendChild(td);
      tabelBody.appendChild(tr);
      return;
    }

    for (const t of rows) {
      const tr = document.createElement('tr');

      const tdWaktu = document.createElement('td');
      tdWaktu.textContent = t.waktu;

      const tdJenis = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'jenis-badge ' + (t.jenis === 'masuk' ? 'badge-masuk' : 'badge-keluar');
      badge.textContent = t.jenis === 'masuk' ? window.t('tx.masuk') : window.t('tx.keluar');
      tdJenis.appendChild(badge);

      const tdKet = document.createElement('td');
      tdKet.className = 'ket';
      tdKet.textContent = t.keterangan;

      const tdJumlah = document.createElement('td');
      tdJumlah.className = 'num ' + (t.jenis === 'masuk' ? 'amount-in' : 'amount-out');
      tdJumlah.textContent = (t.jenis === 'masuk' ? '+' : '−') + t.jumlah_format;

      const tdAksi = document.createElement('td');
      tdAksi.className = 'num';
      const btn = document.createElement('button');
      btn.className = 'hapus';
      btn.dataset.id = t.id;
      btn.title = window.t('tx.hapusTitle');
      btn.setAttribute('aria-label', window.t('tx.hapusAria', { ket: t.keterangan }));
      btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13h10l1-13"/></svg>';

      tdAksi.appendChild(btn);
      tr.append(tdWaktu, tdJenis, tdKet, tdJumlah, tdAksi);
      tabelBody.appendChild(tr);
    }
  }

  // ------------------------------------------------------------------
  // Render: chart tren saldo (garis, Ringkasan)
  // ------------------------------------------------------------------
  function renderTrend(data) {
    const wrap = document.getElementById('chart-trend');
    const seri = seriSaldoHarian(data.transaksi);
    wrap.textContent = '';

    if (seri.length < 2) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = window.t('chart.emptyTrend');
      wrap.appendChild(empty);
      return;
    }

    const W = Math.max(280, wrap.clientWidth);
    const H = 210;
    const padL = 52, padR = 12, padT = 10, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const nilaiMin = Math.min(0, ...seri.map((d) => d.saldo));
    const nilaiMaks = Math.max(1, ...seri.map((d) => d.saldo));
    const atas = skalaTick(nilaiMaks);
    // Jika ada saldo negatif, perluas ke bawah dengan langkah yang sama.
    const step = atas.ticks[1] - atas.ticks[0];
    let low = 0;
    while (low > nilaiMin) low -= step;
    const ticks = [];
    for (let v = low; v <= atas.max + step / 2; v += step) ticks.push(v);
    const yMin = low, yMax = atas.max;

    const x = (i) => padL + (plotW * i) / (seri.length - 1);
    const y = (v) => padT + plotH * (1 - (v - yMin) / (yMax - yMin));

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
    svg.setAttribute('aria-label', window.t('chart.trendAria'));

    const cGrid = cssVar('--hairline'), cBase = cssVar('--baseline'),
          cMuted = cssVar('--muted'), cIncome = cssVar('--income'),
          cSurface = cssVar('--surface');

    // Gridline + label tick Y
    for (const v of ticks) {
      const gy = y(v);
      svg.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: v === 0 ? cBase : cGrid, 'stroke-width': 1 }));
      const label = svgEl('text', { x: padL - 8, y: gy + 3.5, 'text-anchor': 'end', 'font-size': 11, fill: cMuted });
      label.textContent = angkaRingkas(v);
      svg.appendChild(label);
    }

    // Label X: awal, tengah, akhir
    const idxLabel = seri.length > 2 ? [0, Math.floor((seri.length - 1) / 2), seri.length - 1] : [0, seri.length - 1];
    for (const i of new Set(idxLabel)) {
      const label = svgEl('text', {
        x: x(i), y: H - 8, 'font-size': 11, fill: cMuted,
        'text-anchor': i === 0 ? 'start' : (i === seri.length - 1 ? 'end' : 'middle')
      });
      label.textContent = tanggalPendek(seri[i].tanggal + ' ');
      svg.appendChild(label);
    }

    // Area wash (~10%) + garis 2px
    let dLine = '', dArea = '';
    seri.forEach((p, i) => {
      const px = x(i), py = y(p.saldo);
      dLine += (i === 0 ? 'M' : 'L') + px + ' ' + py;
      dArea += (i === 0 ? 'M' : 'L') + px + ' ' + py;
    });
    dArea += `L${x(seri.length - 1)} ${y(Math.max(yMin, 0))}L${x(0)} ${y(Math.max(yMin, 0))}Z`;
    svg.appendChild(svgEl('path', { d: dArea, fill: cIncome, opacity: 0.1 }));
    svg.appendChild(svgEl('path', { d: dLine, fill: 'none', stroke: cIncome, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // Titik akhir dengan cincin surface 2px
    const last = seri[seri.length - 1];
    svg.appendChild(svgEl('circle', { cx: x(seri.length - 1), cy: y(last.saldo), r: 4, fill: cIncome, stroke: cSurface, 'stroke-width': 2 }));

    // Crosshair + tooltip
    const crosshair = svgEl('line', { y1: padT, y2: padT + plotH, stroke: cBase, 'stroke-width': 1, visibility: 'hidden' });
    const hoverDot = svgEl('circle', { r: 4, fill: cIncome, stroke: cSurface, 'stroke-width': 2, visibility: 'hidden' });
    svg.appendChild(crosshair);
    svg.appendChild(hoverDot);

    const tip = buatTooltip(wrap);
    const overlay = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
    overlay.style.cursor = 'crosshair';
    overlay.addEventListener('pointermove', (e) => {
      const rect = svg.getBoundingClientRect();
      const relX = (e.clientX - rect.left) * (W / rect.width);
      let i = Math.round(((relX - padL) / plotW) * (seri.length - 1));
      i = Math.max(0, Math.min(seri.length - 1, i));
      const p = seri[i];
      crosshair.setAttribute('x1', x(i));
      crosshair.setAttribute('x2', x(i));
      crosshair.setAttribute('visibility', 'visible');
      hoverDot.setAttribute('cx', x(i));
      hoverDot.setAttribute('cy', y(p.saldo));
      hoverDot.setAttribute('visibility', 'visible');
      isiTooltip(tip, tanggalPendek(p.tanggal + ' ') + ' ' + p.tanggal.slice(0, 4), [
        { warna: cIncome, nilai: formatRupiah(p.saldo), label: window.t('tt.saldo') }
      ]);
      posisikanTooltip(tip, wrap, x(i) * (rect.width / W), y(p.saldo) * (rect.height / H));
    });
    overlay.addEventListener('pointerleave', () => {
      crosshair.setAttribute('visibility', 'hidden');
      hoverDot.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    });
    svg.appendChild(overlay);

    wrap.appendChild(svg);
    wrap.appendChild(tip);
  }

  // ------------------------------------------------------------------
  // Render: chart bulanan (bar berpasangan, Laporan)
  // ------------------------------------------------------------------
  function batangBulatAtas(px, py, w, h, baselineY) {
    // Batang dengan ujung-data membulat 4px, siku di baseline.
    const r = Math.min(4, w / 2, h);
    return `M${px} ${baselineY}V${py + r}Q${px} ${py} ${px + r} ${py}H${px + w - r}Q${px + w} ${py} ${px + w} ${py + r}V${baselineY}Z`;
  }

  function renderBulanan(data) {
    const wrap = document.getElementById('chart-bulanan');
    const rekap = rekapBulanan(data.transaksi).slice(-12); // maksimal 12 bulan terakhir
    wrap.textContent = '';

    // Tabel laporan (selalu ada — twin dari chart)
    const lapBody = document.getElementById('lap-tabel-body');
    lapBody.textContent = '';
    for (const r of rekapBulanan(data.transaksi)) {
      const tr = document.createElement('tr');
      const selisih = r.masuk - r.keluar;
      const cells = [
        [bulanLabel(r.bulan), ''],
        [formatRupiah(r.masuk), 'num'],
        [formatRupiah(r.keluar), 'num'],
        [(selisih >= 0 ? '+' : '−') + formatRupiah(Math.abs(selisih)), 'num']
      ];
      cells.forEach(([txt, cls]) => {
        const td = document.createElement('td');
        td.textContent = txt;
        if (cls) td.className = cls;
        tr.appendChild(td);
      });
      lapBody.appendChild(tr);
    }

    if (rekap.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chart-empty';
      empty.textContent = window.t('chart.emptyData');
      wrap.appendChild(empty);
      return;
    }

    const W = Math.max(280, wrap.clientWidth);
    const H = 230;
    const padL = 52, padR = 12, padT = 10, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const baselineY = padT + plotH;

    const maks = Math.max(1, ...rekap.map((r) => Math.max(r.masuk, r.keluar)));
    const { max: yMax, ticks } = skalaTick(maks);
    const y = (v) => padT + plotH * (1 - v / yMax);

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
    svg.setAttribute('aria-label', window.t('chart.bulanAria'));

    const cGrid = cssVar('--hairline'), cBase = cssVar('--baseline'),
          cMuted = cssVar('--muted'), cIncome = cssVar('--income'),
          cExpense = cssVar('--expense');

    for (const v of ticks) {
      const gy = y(v);
      if (v !== 0) svg.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, stroke: cGrid, 'stroke-width': 1 }));
      const label = svgEl('text', { x: padL - 8, y: gy + 3.5, 'text-anchor': 'end', 'font-size': 11, fill: cMuted });
      label.textContent = angkaRingkas(v);
      svg.appendChild(label);
    }
    svg.appendChild(svgEl('line', { x1: padL, y1: baselineY, x2: W - padR, y2: baselineY, stroke: cBase, 'stroke-width': 1 }));

    const band = plotW / rekap.length;
    const barW = Math.min(24, Math.max(8, (band - 24) / 2)); // batang tipis, jangan penuhi slot
    const gap = 2; // celah surface antar batang bersebelahan

    const tip = buatTooltip(wrap);

    rekap.forEach((r, i) => {
      const cx = padL + band * i + band / 2;
      const xMasuk = cx - barW - gap / 2;
      const xKeluar = cx + gap / 2;

      if (r.masuk > 0) {
        svg.appendChild(svgEl('path', { d: batangBulatAtas(xMasuk, y(r.masuk), barW, baselineY - y(r.masuk), baselineY), fill: cIncome }));
      }
      if (r.keluar > 0) {
        svg.appendChild(svgEl('path', { d: batangBulatAtas(xKeluar, y(r.keluar), barW, baselineY - y(r.keluar), baselineY), fill: cExpense }));
      }

      // Label bulan (tampilkan sebagian bila sempit)
      const setiap = Math.ceil(rekap.length / Math.floor(plotW / 56));
      if (i % Math.max(1, setiap) === 0 || i === rekap.length - 1) {
        const label = svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: cMuted });
        label.textContent = bulanLabel(r.bulan);
        svg.appendChild(label);
      }

      // Hit target satu grup bulan: tooltip berisi kedua seri
      const hit = svgEl('rect', { x: padL + band * i, y: padT, width: band, height: plotH, fill: 'transparent' });
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'img');
      hit.setAttribute('aria-label', window.t('lap.ariaBulan', { bulan: bulanLabel(r.bulan), masuk: formatRupiah(r.masuk), keluar: formatRupiah(r.keluar) }));
      const tampil = (clientX) => {
        const rect = svg.getBoundingClientRect();
        isiTooltip(tip, bulanLabel(r.bulan), [
          { warna: cIncome, nilai: formatRupiah(r.masuk), label: window.t('tt.masuk') },
          { warna: cExpense, nilai: formatRupiah(r.keluar), label: window.t('tt.keluar') }
        ]);
        const topY = Math.min(y(r.masuk), y(r.keluar));
        posisikanTooltip(tip, wrap, cx * (rect.width / W), topY * (rect.height / H));
      };
      hit.addEventListener('pointermove', (e) => tampil(e.clientX));
      hit.addEventListener('focus', () => tampil(null));
      hit.addEventListener('pointerleave', () => { tip.hidden = true; });
      hit.addEventListener('blur', () => { tip.hidden = true; });
      svg.appendChild(hit);
    });

    wrap.appendChild(svg);
    wrap.appendChild(tip);
  }

  function renderLaporanStats(data) {
    const rekap = rekapBulanan(data.transaksi);
    const n = Math.max(1, rekap.length);
    const totalMasuk = rekap.reduce((s, r) => s + r.masuk, 0);
    const totalKeluar = rekap.reduce((s, r) => s + r.keluar, 0);
    document.getElementById('lap-avg-masuk').textContent = formatRupiah(rekap.length ? totalMasuk / n : 0);
    document.getElementById('lap-avg-keluar').textContent = formatRupiah(rekap.length ? totalKeluar / n : 0);

    const terbesar = data.transaksi.reduce((best, t) => (!best || t.jumlah > best.jumlah ? t : best), null);
    document.getElementById('lap-terbesar').textContent = terbesar ? terbesar.jumlah_format : 'Rp 0';
    document.getElementById('lap-terbesar-sub').textContent = terbesar
      ? `${terbesar.jenis === 'masuk' ? window.t('tx.masuk') : window.t('tx.keluar')} · ${terbesar.keterangan}`
      : ' ';
  }

  function renderCharts() {
    if (!appData) return;
    if (activeTab === 'ringkasan') renderTrend(appData);
    if (activeTab === 'laporan') renderBulanan(appData);
  }

  function renderAll(data) {
    appData = data;
    renderStats(data);
    renderRecent(data);
    renderTable(data);
    renderLaporanStats(data);
    renderCharts();
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 150);
  });

  // ------------------------------------------------------------------
  // Data & auth
  // ------------------------------------------------------------------
  function setPesan(text, ok) {
    pesanError.textContent = text;
    pesanError.className = 'form-msg' + (text ? (ok ? ' is-ok' : ' is-error') : '');
  }

  async function muatUlang() {
    try {
      const response = await fetch('/api/transactions');
      if (response.ok) {
        renderAll(await response.json());
      } else {
        setPesan(window.t('msg.loadFail'), false);
      }
    } catch (err) {
      console.error('Failed to load transactions:', err);
      setPesan(window.t('msg.netFail'), false);
    }
  }

  async function loadTelegramBotLink() {
    try {
      const response = await fetch('/api/config');
      const data = await response.json();
      if (data.telegramBotUrl) {
        document.getElementById('telegram-bot-link').href = data.telegramBotUrl;
      }
    } catch (err) {
      console.error('Gagal memuat konfigurasi bot Telegram:', err);
    }
  }

  let telegramStatus = null; // cache untuk render ulang saat ganti bahasa

  function renderTelegramStatus() {
    const descEl = document.getElementById('telegram-status-desc');
    const btnUnlink = document.getElementById('btn-telegram-unlink');
    const data = telegramStatus;
    if (!data) return;
    descEl.removeAttribute('data-i18n'); // JS yang memiliki teks ini sekarang
    if (data.gagal) {
      descEl.textContent = window.t('tg.statusFail');
      return;
    }
    if (data.linked) {
      descEl.textContent = data.username
        ? window.t('tg.connectedAs', { name: '@' + data.username })
        : (data.name ? window.t('tg.connectedAs', { name: data.name }) : window.t('tg.connected'));
      btnUnlink.hidden = false;
    } else {
      descEl.textContent = window.t('tg.notConnected');
      btnUnlink.hidden = true;
    }
  }

  async function loadTelegramStatus() {
    try {
      const response = await fetch('/api/telegram/status');
      telegramStatus = await response.json();
    } catch (err) {
      console.error('Gagal memuat status Telegram:', err);
      telegramStatus = { gagal: true };
    }
    renderTelegramStatus();
  }

  document.getElementById('btn-telegram-unlink').addEventListener('click', async () => {
    const btnUnlink = document.getElementById('btn-telegram-unlink');
    btnUnlink.disabled = true;
    try {
      await fetch('/api/telegram/unlink', { method: 'POST', credentials: 'same-origin' });
    } finally {
      btnUnlink.disabled = false;
      loadTelegramStatus();
    }
  });

  // ------------------------------------------------------------------
  // Token API (Personal Access Token): buat, tampilkan sekali, cabut.
  // Kontrak endpoint (BELUM ada backend — bentuk akhir menyesuaikan):
  //   GET  /api/tokens            -> { tokens: [{ id, label, createdAt, lastUsedAt }] }
  //   POST /api/tokens            body { label } -> { id, label, createdAt, token }
  //                                   (field "token" = nilai mentah, hanya sekali ini)
  //   POST /api/tokens/:id/revoke -> { ok: true }
  // ------------------------------------------------------------------
  let patTokens = null; // cache untuk render ulang saat ganti bahasa
  let patCabutId = null; // id token yang sedang menunggu konfirmasi cabut

  function formatWaktuPat(iso) {
    if (!iso) return window.t('set.patBelumDipakai');
    try {
      return new Date(iso).toLocaleString(window.getLang() === 'id' ? 'id-ID' : window.getLang(), {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
      });
    } catch (err) {
      return iso;
    }
  }

  function renderPatList() {
    const listEl = document.getElementById('pat-list');
    const emptyEl = document.getElementById('pat-empty');
    if (!patTokens) return;
    listEl.innerHTML = '';
    if (patTokens.length === 0) {
      listEl.hidden = true;
      emptyEl.hidden = false;
      return;
    }
    listEl.hidden = false;
    emptyEl.hidden = true;
    patTokens.forEach((tok) => {
      const li = document.createElement('li');
      li.className = 'pat-row';
      li.dataset.patId = tok.id;
      const info = document.createElement('div');
      info.className = 'pat-row-info';
      const label = document.createElement('div');
      label.className = 'pat-row-label';
      label.textContent = tok.label;
      const meta = document.createElement('div');
      meta.className = 'pat-row-meta';
      meta.textContent = window.t('set.patMeta', {
        dibuat: formatWaktuPat(tok.createdAt),
        dipakai: tok.lastUsedAt ? formatWaktuPat(tok.lastUsedAt) : window.t('set.patBelumDipakai')
      });
      info.appendChild(label);
      info.appendChild(meta);
      const btnCabut = document.createElement('button');
      btnCabut.type = 'button';
      btnCabut.className = 'pat-row-revoke';
      btnCabut.textContent = window.t('set.patCabut');
      btnCabut.addEventListener('click', () => {
        patCabutId = tok.id;
        document.getElementById('pat-cabut-msg').textContent = window.t('set.patCabutMsg', { label: tok.label });
        bukaKonfirmasi('cf-pat-cabut');
      });
      li.appendChild(info);
      li.appendChild(btnCabut);
      listEl.appendChild(li);
    });
  }

  async function loadPatTokens() {
    try {
      const response = await fetch('/api/tokens', { credentials: 'same-origin' });
      const data = await response.json();
      patTokens = Array.isArray(data.tokens) ? data.tokens : [];
    } catch (err) {
      console.error('Gagal memuat token API:', err);
      patTokens = patTokens || [];
    }
    renderPatList();
  }

  document.getElementById('btn-pat-buat').addEventListener('click', () => {
    document.getElementById('form-pat-buat').reset();
    document.getElementById('pat-buat-msg').textContent = '';
    bukaKonfirmasi('cf-pat-buat', '#pat-label');
  });

  document.getElementById('form-pat-buat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('pat-buat-msg');
    const label = document.getElementById('pat-label').value.trim();
    if (!label) return;
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    try {
      const response = await fetch('/api/tokens', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label })
      });
      const data = await response.json();
      if (!response.ok) {
        msgEl.textContent = data.error || window.t('set.patGagal');
        msgEl.className = 'form-msg is-error';
        return;
      }
      // Simpan token mentah hanya di memori sesaat untuk ditampilkan sekali.
      document.getElementById('pat-reveal-value').textContent = data.token;
      document.getElementById('pat-copy-msg').textContent = '';
      bukaKonfirmasi('cf-pat-reveal');
      loadPatTokens();
    } catch (err) {
      msgEl.textContent = window.t('set.patGagal');
      msgEl.className = 'form-msg is-error';
    }
  });

  const btnMcpUrlCopy = document.getElementById('btn-mcp-url-copy');
  if (btnMcpUrlCopy) {
    btnMcpUrlCopy.addEventListener('click', async () => {
      const value = document.getElementById('mcp-url').textContent;
      const original = btnMcpUrlCopy.textContent;
      try {
        await navigator.clipboard.writeText(value);
        btnMcpUrlCopy.textContent = window.t('set.patTersalinSingkat');
      } catch (err) {
        btnMcpUrlCopy.textContent = window.t('set.patGagalSalin');
      }
      setTimeout(() => { btnMcpUrlCopy.textContent = original; }, 1600);
    });
  }

  document.getElementById('btn-pat-copy').addEventListener('click', async () => {
    const value = document.getElementById('pat-reveal-value').textContent;
    const copyMsgEl = document.getElementById('pat-copy-msg');
    try {
      await navigator.clipboard.writeText(value);
      copyMsgEl.textContent = window.t('set.patTersalin');
      copyMsgEl.className = 'form-msg is-ok';
    } catch (err) {
      copyMsgEl.textContent = window.t('set.patGagalSalin');
      copyMsgEl.className = 'form-msg is-error';
    }
  });

  document.getElementById('btn-pat-cabut-confirm').addEventListener('click', async () => {
    if (!patCabutId) return;
    const btn = document.getElementById('btn-pat-cabut-confirm');
    btn.disabled = true;
    try {
      await fetch('/api/tokens/' + encodeURIComponent(patCabutId) + '/revoke', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } finally {
      btn.disabled = false;
      patCabutId = null;
      tutupKonfirmasi();
      loadPatTokens();
    }
  });

  // ------------------------------------------------------------------
  // MFA / verifikasi dua langkah (TOTP)
  // ------------------------------------------------------------------
  let mfaState = { enabled: false, backupCodesRemaining: 0 };
  let mfaEnroll = { secret: '', otpauthUri: '', backupCodes: [] }; // sementara, saat enroll

  function renderMfaStatus() {
    const desc = document.getElementById('mfa-status-desc');
    const btnEnable = document.getElementById('btn-mfa-enable');
    const btnDisable = document.getElementById('btn-mfa-disable');
    const backupRow = document.getElementById('mfa-backup-row');
    const backupDesc = document.getElementById('mfa-backup-desc');
    if (!desc) return;
    desc.removeAttribute('data-i18n');
    if (mfaState.enabled) {
      desc.textContent = window.t('set.mfaAktif');
      btnEnable.hidden = true;
      btnDisable.hidden = false;
      backupRow.hidden = false;
      backupDesc.removeAttribute('data-i18n');
      backupDesc.textContent = window.t('set.mfaBackupSisa', { n: mfaState.backupCodesRemaining });
    } else {
      desc.textContent = window.t('set.mfaTidakAktif');
      btnEnable.hidden = false;
      btnDisable.hidden = true;
      backupRow.hidden = true;
    }
  }

  async function loadMfaStatus() {
    try {
      const response = await fetch('/api/mfa/status', { credentials: 'same-origin' });
      const data = await response.json();
      mfaState = {
        enabled: Boolean(data.enabled),
        backupCodesRemaining: data.backupCodesRemaining || 0
      };
    } catch (err) {
      console.error('Gagal memuat status MFA:', err);
    }
    renderMfaStatus();
  }

  function renderMfaBackupCodes(ulId, codes) {
    const ul = document.getElementById(ulId);
    if (!ul) return;
    ul.innerHTML = '';
    codes.forEach((c) => {
      const li = document.createElement('li');
      li.textContent = c;
      ul.appendChild(li);
    });
  }

  // Salin teks lalu beri umpan balik singkat pada tombol (pola sama dgn MCP URL).
  async function salinKeClipboard(text, btn) {
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = window.t('set.patTersalinSingkat');
    } catch (err) {
      btn.textContent = window.t('set.patGagalSalin');
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  }

  // Aktifkan — langkah 1: minta password
  document.getElementById('btn-mfa-enable').addEventListener('click', () => {
    document.getElementById('form-mfa-enable').reset();
    document.getElementById('mfa-enable-msg').textContent = '';
    document.getElementById('mfa-enable-msg').className = 'form-msg';
    bukaKonfirmasi('cf-mfa-enable', '#mfa-enable-password');
  });

  document.getElementById('form-mfa-enable').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('mfa-enable-msg');
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    const currentPassword = document.getElementById('mfa-enable-password').value;
    try {
      const response = await fetch('/api/mfa/enable/start', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword })
      });
      const data = await response.json();
      if (!response.ok) {
        msgEl.textContent = data.error ? window.tServer(data.error) : window.t('set.mfaGagal');
        msgEl.className = 'form-msg is-error';
        return;
      }
      mfaEnroll = { secret: data.secret, otpauthUri: data.otpauthUri, backupCodes: data.backupCodes };
      document.getElementById('mfa-secret-value').textContent = data.secret;
      document.getElementById('mfa-uri-value').textContent = data.otpauthUri;
      renderMfaBackupCodes('mfa-setup-backup-list', data.backupCodes);
      document.getElementById('form-mfa-confirm').reset();
      document.getElementById('mfa-setup-msg').textContent = '';
      document.getElementById('mfa-setup-msg').className = 'form-msg';
      bukaKonfirmasi('cf-mfa-setup', '#mfa-confirm-code');
    } catch (err) {
      msgEl.textContent = window.t('set.mfaGagal');
      msgEl.className = 'form-msg is-error';
    }
  });

  document.getElementById('btn-mfa-secret-copy').addEventListener('click', (e) => {
    salinKeClipboard(mfaEnroll.secret, e.currentTarget);
  });
  document.getElementById('btn-mfa-uri-copy').addEventListener('click', (e) => {
    salinKeClipboard(mfaEnroll.otpauthUri, e.currentTarget);
  });
  document.getElementById('btn-mfa-setup-backup-copy').addEventListener('click', (e) => {
    salinKeClipboard(mfaEnroll.backupCodes.join('\n'), e.currentTarget);
  });

  // Aktifkan — langkah 2: konfirmasi kode TOTP → enabled
  document.getElementById('form-mfa-confirm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('mfa-setup-msg');
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    const code = document.getElementById('mfa-confirm-code').value.trim();
    try {
      const response = await fetch('/api/mfa/enable/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await response.json();
      if (!response.ok) {
        msgEl.textContent = data.error ? window.tServer(data.error) : window.t('set.mfaGagal');
        msgEl.className = 'form-msg is-error';
        return;
      }
      mfaEnroll = { secret: '', otpauthUri: '', backupCodes: [] };
      tutupKonfirmasi();
      loadMfaStatus();
    } catch (err) {
      msgEl.textContent = window.t('set.mfaGagal');
      msgEl.className = 'form-msg is-error';
    }
  });

  // Nonaktifkan — password + kode
  document.getElementById('btn-mfa-disable').addEventListener('click', () => {
    document.getElementById('form-mfa-disable').reset();
    document.getElementById('mfa-disable-msg').textContent = '';
    document.getElementById('mfa-disable-msg').className = 'form-msg';
    bukaKonfirmasi('cf-mfa-disable', '#mfa-disable-password');
  });

  document.getElementById('form-mfa-disable').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('mfa-disable-msg');
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    const currentPassword = document.getElementById('mfa-disable-password').value;
    const code = document.getElementById('mfa-disable-code').value.trim();
    try {
      const response = await fetch('/api/mfa/disable', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, code })
      });
      const data = await response.json();
      if (!response.ok) {
        msgEl.textContent = data.error ? window.tServer(data.error) : window.t('set.mfaGagal');
        msgEl.className = 'form-msg is-error';
        return;
      }
      tutupKonfirmasi();
      loadMfaStatus();
    } catch (err) {
      msgEl.textContent = window.t('set.mfaGagal');
      msgEl.className = 'form-msg is-error';
    }
  });

  // Buat ulang kode cadangan — password
  document.getElementById('btn-mfa-regen').addEventListener('click', () => {
    document.getElementById('form-mfa-regen').reset();
    document.getElementById('mfa-regen-msg').textContent = '';
    document.getElementById('mfa-regen-msg').className = 'form-msg';
    bukaKonfirmasi('cf-mfa-regen', '#mfa-regen-password');
  });

  document.getElementById('form-mfa-regen').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = document.getElementById('mfa-regen-msg');
    msgEl.textContent = '';
    msgEl.className = 'form-msg';
    const currentPassword = document.getElementById('mfa-regen-password').value;
    try {
      const response = await fetch('/api/mfa/backup-codes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword })
      });
      const data = await response.json();
      if (!response.ok) {
        msgEl.textContent = data.error ? window.tServer(data.error) : window.t('set.mfaGagal');
        msgEl.className = 'form-msg is-error';
        return;
      }
      mfaEnroll.backupCodes = data.backupCodes;
      renderMfaBackupCodes('mfa-reveal-backup-list', data.backupCodes);
      document.getElementById('mfa-backup-copy-msg').textContent = '';
      bukaKonfirmasi('cf-mfa-backup-reveal');
      loadMfaStatus();
    } catch (err) {
      msgEl.textContent = window.t('set.mfaGagal');
      msgEl.className = 'form-msg is-error';
    }
  });

  document.getElementById('btn-mfa-reveal-backup-copy').addEventListener('click', (e) => {
    salinKeClipboard(mfaEnroll.backupCodes.join('\n'), e.currentTarget);
  });

  let namaTampilan = null; // nama untuk sapaan; cache untuk ganti bahasa

  function terapkanSapaan() {
    if (!namaTampilan) return;
    const greetingEl = document.getElementById('greeting');
    greetingEl.removeAttribute('data-i18n'); // JS yang memiliki teks ini sekarang
    greetingEl.textContent = window.t('greeting.full', { nama: namaTampilan });
    document.getElementById('sidebar-username').textContent = namaTampilan;
    document.getElementById('mobile-username').textContent = namaTampilan;
    document.getElementById('profil-nama').textContent = namaTampilan;
  }

  async function checkAuthAndRender() {
    try {
      const response = await fetch('/api/me');
      if (response.ok) {
        const data = await response.json();
        namaTampilan = data.displayName || data.username;
        terapkanSapaan();
        document.getElementById('setting-username').textContent = data.username;
        if (data.email) tampilkanEmail(data.email);
        document.getElementById('profil-username').textContent = '@' + data.username;
        document.getElementById('nama-panggilan').value = data.displayName || '';
        renderSemuaAvatar(data.avatarUrl, data.userId || data.username);
        await muatUlang();
        loadTelegramBotLink();
        loadTelegramStatus();
        loadPatTokens();
        loadMfaStatus();
      } else {
        window.location.href = '/login';
      }
    } catch (err) {
      console.error('Gagal memeriksa status login:', err);
      window.location.href = '/login';
    }
  }

  // ------------------------------------------------------------------
  // Aksi: tambah, hapus, filter, logout
  // ------------------------------------------------------------------
  // FAB + panel melayang "Tambah transaksi".
  const fabTambah = document.getElementById('fab-tambah');
  const txOverlay = document.getElementById('tx-overlay');
  const txSheet = document.getElementById('tx-sheet');
  const txSheetClose = document.getElementById('tx-sheet-close');
  const jenisSeg = document.getElementById('tx-jenis-seg');
  let sheetTimer = null;

  // Ukur tinggi tabbar SUNGGUHAN (bukan tebakan) supaya FAB selalu pas di
  // atasnya, kebal terhadap address bar Chrome yang mengubah tinggi viewport.
  // Di desktop .tabbar bertinggi 0 (display:none) — tak masalah, media query
  // desktop untuk .fab/.tx-sheet sudah override bottom-nya secara eksplisit.
  function ukurClearanceFab() {
    const tabbar = document.querySelector('.tabbar');
    const tinggi = tabbar ? tabbar.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--fab-clear', `${tinggi + 12}px`);
  }
  ukurClearanceFab();
  let fabResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(fabResizeTimer);
    fabResizeTimer = setTimeout(ukurClearanceFab, 120);
  });
  window.addEventListener('orientationchange', () => setTimeout(ukurClearanceFab, 200));

  function bukaSheet() {
    clearTimeout(sheetTimer);
    txOverlay.hidden = false;
    txSheet.hidden = false;
    void txSheet.offsetHeight; // paksa reflow agar transisi buka berjalan
    txOverlay.classList.add('is-open');
    txSheet.classList.add('is-open');
    fabTambah.classList.add('is-open');
    fabTambah.setAttribute('aria-expanded', 'true');
    document.documentElement.classList.add('tx-modal-open'); // kunci scroll di belakang panel
    setPesan('', true);
    document.getElementById('tx-keterangan').focus();
  }

  function tutupSheet(kembalikanFokus) {
    if (txSheet.hidden) return;
    txOverlay.classList.remove('is-open');
    txSheet.classList.remove('is-open');
    fabTambah.classList.remove('is-open');
    fabTambah.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('tx-modal-open');
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(() => {
      txOverlay.hidden = true;
      txSheet.hidden = true;
    }, 240); // selaras dengan durasi transisi CSS
    if (kembalikanFokus !== false) fabTambah.focus();
  }

  fabTambah.addEventListener('click', () => {
    if (txSheet.hidden || !txSheet.classList.contains('is-open')) bukaSheet();
    else tutupSheet();
  });
  txSheetClose.addEventListener('click', () => tutupSheet());
  txOverlay.addEventListener('click', () => tutupSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') tutupSheet();
  });

  // Segmented jenis: perbarui input hidden agar formTransaksi.jenis.value tetap bekerja.
  jenisSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-jenis]');
    if (!btn) return;
    formTransaksi.jenis.value = btn.dataset.jenis;
    jenisSeg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', b === btn);
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
  });

  formTransaksi.addEventListener('submit', async (e) => {
    e.preventDefault();
    setPesan('', true);

    const jenis = formTransaksi.jenis.value;
    const keterangan = formTransaksi.keterangan.value;
    const jumlah = formTransaksi.jumlah.value.replace(/\./g, '').replace(/,/g, '');

    try {
      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jenis, keterangan, jumlah })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        setPesan(hasil.error ? window.tServer(hasil.error) : window.t('msg.err'), false);
        return;
      }
      formTransaksi.keterangan.value = '';
      formTransaksi.jumlah.value = '';
      setPesan(window.t('msg.txSaved'), true);
      renderAll(hasil);
      tutupSheet(); // sukses: tutup panel, biarkan tabel ter-render di belakang
    } catch (err) {
      console.error('Failed to submit transaction:', err);
      setPesan(window.t('msg.netFail'), false);
    }
  });

  tabelBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.hapus');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    if (isNaN(id)) return;
    if (!window.confirm(window.t('tx.hapusConfirm'))) return;

    setPesan('', true);
    try {
      const response = await fetch('/api/transactions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        setPesan(hasil.error ? window.tServer(hasil.error) : window.t('msg.delFail'), false);
        return;
      }
      renderAll(hasil);
    } catch (err) {
      console.error('Failed to delete transaction:', err);
      setPesan(window.t('msg.netFail'), false);
    }
  });

  txSearch.addEventListener('input', () => {
    searchQuery = txSearch.value;
    if (appData) renderTable(appData);
  });

  document.querySelectorAll('.segmented [data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filterJenis = btn.dataset.filter;
      document.querySelectorAll('.segmented [data-filter]').forEach((b) => {
        b.classList.toggle('is-active', b === btn);
      });
      if (appData) renderTable(appData);
    });
  });

  // ------------------------------------------------------------------
  // Jendela konfirmasi melayang (.cf-sheet) — pola buka/tutup yang sama
  // dengan tx-sheet: overlay klik, Escape, tombol tutup/batal, kunci scroll.
  // Satu manajer generik; setiap aksi sensitif punya sheet-nya sendiri.
  // ------------------------------------------------------------------
  const cfOverlay = document.getElementById('cf-overlay');
  let cfAktif = null;      // elemen .cf-sheet yang sedang terbuka
  let cfTimer = null;
  let cfFokusAsal = null;  // tombol pemicu, untuk kembalikan fokus saat tutup

  function bukaKonfirmasi(id, fokusSelector) {
    tutupKonfirmasi(false);
    clearTimeout(cfTimer);
    const sheet = document.getElementById(id);
    if (!sheet) return;
    cfAktif = sheet;
    cfFokusAsal = document.activeElement;
    tutupSheet(false); // jangan tumpuk dengan panel transaksi
    cfOverlay.hidden = false;
    sheet.hidden = false;
    void sheet.offsetHeight; // paksa reflow agar transisi buka berjalan
    cfOverlay.classList.add('is-open');
    sheet.classList.add('is-open');
    document.documentElement.classList.add('tx-modal-open');
    const fokus = fokusSelector
      ? sheet.querySelector(fokusSelector)
      : sheet.querySelector('input:not([hidden]), .cf-actions button:last-child');
    if (fokus) fokus.focus();
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
    }, 240); // selaras dengan durasi transisi CSS
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
  // Logout: tombol hanya mengumumkan niat; aksi jalan setelah konfirmasi
  // ------------------------------------------------------------------
  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      window.location.href = '/';
    }
  }
  document.getElementById('btn-logout').addEventListener('click', () => bukaKonfirmasi('cf-logout'));
  document.getElementById('btn-logout-settings').addEventListener('click', () => bukaKonfirmasi('cf-logout'));
  document.getElementById('btn-logout-confirm').addEventListener('click', logout);

  // ------------------------------------------------------------------
  // Profil: nama panggilan & foto
  // ------------------------------------------------------------------
  const formNama = document.getElementById('form-nama');
  const namaMsg = document.getElementById('nama-msg');
  formNama.addEventListener('submit', async (e) => {
    e.preventDefault();
    namaMsg.textContent = '';
    const displayName = formNama.displayName.value.trim();
    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        namaMsg.textContent = hasil.error ? window.tServer(hasil.error) : window.t('msg.namaFail');
        namaMsg.className = 'form-msg is-error';
        return;
      }
      namaMsg.textContent = window.t('msg.tersimpan');
      namaMsg.className = 'form-msg is-ok';
      if (hasil.displayName) {
        namaTampilan = hasil.displayName;
        terapkanSapaan();
      }
    } catch (err) {
      console.error('Failed to save display name:', err);
      namaMsg.textContent = window.t('msg.netFail');
      namaMsg.className = 'form-msg is-error';
    }
  });

  // Ganti password: form asli sekarang hidup di jendela konfirmasi cf-password
  const formPassword = document.getElementById('form-password');
  const passwordMsg = document.getElementById('password-msg');
  document.getElementById('btn-ganti-password').addEventListener('click', () => {
    formPassword.reset();
    passwordMsg.textContent = '';
    passwordMsg.className = 'form-msg';
    bukaKonfirmasi('cf-password');
  });
  formPassword.addEventListener('submit', async (e) => {
    e.preventDefault();
    passwordMsg.textContent = '';
    const currentPassword = formPassword.currentPassword.value;
    const newPassword = formPassword.newPassword.value;
    try {
      const response = await fetch('/api/profile/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        passwordMsg.textContent = hasil.error ? window.tServer(hasil.error) : window.t('msg.pwFail');
        passwordMsg.className = 'form-msg is-error';
        return;
      }
      passwordMsg.textContent = window.t('msg.pwSaved');
      passwordMsg.className = 'form-msg is-ok';
      formPassword.reset();
    } catch (err) {
      console.error('Failed to change password:', err);
      passwordMsg.textContent = window.t('msg.netFail');
      passwordMsg.className = 'form-msg is-error';
    }
  });

  const avatarInput = document.getElementById('avatar-input');
  const avatarMsg = document.getElementById('avatar-msg');
  const MAX_AVATAR_BYTES = 1.5 * 1024 * 1024;

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files && avatarInput.files[0];
    avatarInput.value = '';
    if (!file) return;

    avatarMsg.textContent = '';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      avatarMsg.textContent = window.t('msg.fmtFoto');
      avatarMsg.className = 'form-msg is-error';
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      avatarMsg.textContent = window.t('msg.fotoBesar');
      avatarMsg.className = 'form-msg is-error';
      return;
    }

    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const imageBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

      const response = await fetch('/api/profile/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, mimeType: file.type })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        avatarMsg.textContent = hasil.error ? window.tServer(hasil.error) : window.t('msg.fotoFail');
        avatarMsg.className = 'form-msg is-error';
        return;
      }
      avatarMsg.textContent = window.t('msg.fotoSaved');
      avatarMsg.className = 'form-msg is-ok';
      renderSemuaAvatar(hasil.avatarUrl, null);
    } catch (err) {
      console.error('Failed to upload avatar:', err);
      avatarMsg.textContent = window.t('msg.netFail');
      avatarMsg.className = 'form-msg is-error';
    }
  });

  document.getElementById('btn-avatar-hapus').addEventListener('click', async () => {
    avatarMsg.textContent = '';
    try {
      await fetch('/api/profile/avatar/delete', { method: 'POST', credentials: 'same-origin' });
      checkAuthAndRender();
    } catch (err) {
      console.error('Failed to delete avatar:', err);
      avatarMsg.textContent = window.t('msg.netFail');
      avatarMsg.className = 'form-msg is-error';
    }
  });

  // ------------------------------------------------------------------
  // Pengaturan: sub-tab (state UI bersarang, terpisah dari tab utama)
  // ------------------------------------------------------------------
  const subtabButtons = document.querySelectorAll('.subtabs [data-subtab]');
  subtabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      subtabButtons.forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.subtab-panel').forEach((p) => {
        p.classList.toggle('is-active', p.id === 'subtab-' + btn.dataset.subtab);
      });
    });
  });

  // ------------------------------------------------------------------
  // Unduh data: konfirmasi dulu, lalu server mengirim CSV ke email
  // ------------------------------------------------------------------
  const exportMsg = document.getElementById('export-msg');
  const btnExportConfirm = document.getElementById('btn-export-confirm');
  document.getElementById('btn-export-data').addEventListener('click', () => {
    exportMsg.textContent = '';
    bukaKonfirmasi('cf-export');
  });
  btnExportConfirm.addEventListener('click', async () => {
    btnExportConfirm.disabled = true;
    try {
      const response = await fetch('/api/profile/export', { method: 'POST', credentials: 'same-origin' });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        exportMsg.textContent = hasil.error ? window.tServer(hasil.error) : window.t('msg.err');
        exportMsg.className = 'form-msg is-error';
      } else {
        exportMsg.textContent = window.tServer(hasil.message);
        exportMsg.className = 'form-msg is-ok';
      }
    } catch (err) {
      console.error('Failed to request data export:', err);
      exportMsg.textContent = window.t('msg.netFail');
      exportMsg.className = 'form-msg is-error';
    } finally {
      btnExportConfirm.disabled = false;
      tutupKonfirmasi(); // hasil (sukses/galat) tampil di kartu Pengaturan
    }
  });

  // ------------------------------------------------------------------
  // Hapus akun: jendela konfirmasi Zona Merah (cf-hapus) memuat input
  // password — jendela itu sendirilah langkah konfirmasinya.
  // ------------------------------------------------------------------
  const formHapusAkun = document.getElementById('form-hapus-akun');
  const hapusAkunMsg = document.getElementById('hapus-akun-msg');
  document.getElementById('btn-hapus-akun').addEventListener('click', () => {
    formHapusAkun.reset();
    hapusAkunMsg.textContent = '';
    hapusAkunMsg.className = 'form-msg';
    bukaKonfirmasi('cf-hapus');
  });
  formHapusAkun.addEventListener('submit', async (e) => {
    e.preventDefault();
    hapusAkunMsg.textContent = '';
    const password = formHapusAkun.password.value;
    try {
      const response = await fetch('/api/profile/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        hapusAkunMsg.textContent = hasil.error ? window.tServer(hasil.error) : window.t('msg.err');
        hapusAkunMsg.className = 'form-msg is-error';
        return;
      }
      // Sesi sudah dihapus di server; akun tidak ada lagi.
      window.location.href = '/';
    } catch (err) {
      console.error('Failed to delete account:', err);
      hapusAkunMsg.textContent = window.t('msg.netFail');
      hapusAkunMsg.className = 'form-msg is-error';
    }
  });

  // ------------------------------------------------------------------
  // Ganti email: satu jendela (cf-email) dengan dua langkah internal —
  // form email+password → form kode 6 digit. verifyToken hidup di
  // variabel JS ini saja, tidak pernah ditaruh di DOM.
  // ------------------------------------------------------------------
  const formEmailGanti = document.getElementById('form-email-ganti');
  const formEmailKode = document.getElementById('form-email-kode');
  const emailMsg = document.getElementById('email-msg');
  let emailVerifyToken = null;

  function setEmailMsg(text, ok) {
    emailMsg.textContent = text;
    emailMsg.className = 'form-msg' + (text ? (ok ? ' is-ok' : ' is-error') : '');
  }

  document.getElementById('btn-ganti-email').addEventListener('click', () => {
    // Mulai selalu dari langkah 1 dengan state bersih.
    emailVerifyToken = null;
    formEmailGanti.reset();
    formEmailKode.reset();
    formEmailGanti.hidden = false;
    formEmailKode.hidden = true;
    setEmailMsg('', true);
    bukaKonfirmasi('cf-email', '#email-baru');
  });

  formEmailGanti.addEventListener('submit', async (e) => {
    e.preventDefault();
    setEmailMsg('', true);
    const newEmail = formEmailGanti.newEmail.value.trim();
    const currentPassword = formEmailGanti.currentPassword.value;
    try {
      const response = await fetch('/api/profile/email/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newEmail, currentPassword })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        setEmailMsg(hasil.error ? window.tServer(hasil.error) : window.t('msg.err'), false);
        return;
      }
      // Langkah 2: masukkan kode yang dikirim ke email BARU.
      emailVerifyToken = hasil.verifyToken;
      formEmailGanti.hidden = true;
      formEmailKode.hidden = false;
      setEmailMsg(window.tServer(hasil.message), true);
      document.getElementById('email-kode').focus();
    } catch (err) {
      console.error('Failed to request email change:', err);
      setEmailMsg(window.t('msg.netFail'), false);
    }
  });

  formEmailKode.addEventListener('submit', async (e) => {
    e.preventDefault();
    setEmailMsg('', true);
    const code = formEmailKode.code.value.trim();
    try {
      const response = await fetch('/api/profile/email/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: emailVerifyToken, code })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        // Kode salah/kedaluwarsa: tampilkan inline, biarkan pengguna coba lagi.
        setEmailMsg(hasil.error ? window.tServer(hasil.error) : window.t('msg.err'), false);
        return;
      }
      emailVerifyToken = null;
      if (hasil.email) tampilkanEmail(hasil.email);
      tutupKonfirmasi();
    } catch (err) {
      console.error('Failed to confirm email change:', err);
      setEmailMsg(window.t('msg.netFail'), false);
    }
  });

  // ------------------------------------------------------------------
  // Bahasa (i18n.js menyimpan pilihan & menerjemahkan node data-i18n;
  // di sini: tombol segmented + render ulang konten dinamis, mirip tema)
  // ------------------------------------------------------------------
  const langButtons = document.querySelectorAll('[data-lang-choice]');
  function tandaiLang() {
    langButtons.forEach((b) => b.classList.toggle('is-active', b.dataset.langChoice === window.getLang()));
  }
  langButtons.forEach((b) => b.addEventListener('click', () => window.setLang(b.dataset.langChoice)));
  tandaiLang();

  window.addEventListener('langchange', () => {
    tandaiLang();
    terapkanSapaan();
    renderTelegramStatus();
    renderPatList();
    renderMfaStatus();
    if (appData) renderAll(appData); // tabel, statistik, chart, nama bulan
  });

  checkAuthAndRender();
});
