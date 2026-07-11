document.addEventListener('DOMContentLoaded', () => {
  const gateWrap = document.getElementById('gate-wrap');
  const app = document.getElementById('app');
  const pesanError = document.getElementById('pesan-error');
  const tabelBody = document.getElementById('tabel-body');
  const formTransaksi = document.getElementById('form-transaksi');
  const txSearch = document.getElementById('tx-search');
  const txCount = document.getElementById('tx-count');

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const NAMA_BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

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

  // Angka ringkas untuk sumbu: 1,5 jt / 500 rb / 2 M
  function angkaRingkas(n) {
    const abs = Math.abs(n);
    const fmt = (v, suffix) => {
      let s = (Math.round(v * 10) / 10).toString().replace('.', ',');
      if (s.endsWith(',0')) s = s.slice(0, -2);
      return (n < 0 ? '-' : '') + s + suffix;
    };
    if (abs >= 1e9) return fmt(abs / 1e9, ' M');
    if (abs >= 1e6) return fmt(abs / 1e6, ' jt');
    if (abs >= 1e3) return fmt(abs / 1e3, ' rb');
    return String(n);
  }

  // waktu = "YYYY-MM-DD HH:MM:SS"
  function tanggalPendek(waktu) {
    const d = waktu.slice(0, 10).split('-'); // [Y, M, D]
    return `${parseInt(d[2], 10)} ${NAMA_BULAN[parseInt(d[1], 10) - 1]}`;
  }
  function bulanLabel(ym) { // "YYYY-MM"
    const [y, m] = ym.split('-');
    return `${NAMA_BULAN[parseInt(m, 10) - 1]} ${y}`;
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

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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
  function bukaTab(nama) {
    activeTab = nama;
    document.querySelectorAll('.tab').forEach((sec) => {
      sec.classList.toggle('is-active', sec.id === `tab-${nama}`);
    });
    navButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.tab === nama);
    });
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
    document.getElementById('saldo-sub').textContent = `${data.transaksi.length} transaksi tercatat`;
    document.getElementById('masuk-sub').textContent = `${nMasuk} transaksi`;
    document.getElementById('keluar-sub').textContent = `${nKeluar} transaksi`;
    document.getElementById('setting-tx-count').textContent = String(data.transaksi.length);
  }

  function renderRecent(data) {
    const list = document.getElementById('recent-list');
    list.textContent = '';
    const terbaru = data.transaksi.slice(0, 5);
    if (terbaru.length === 0) {
      const li = document.createElement('li');
      li.className = 'kosong';
      li.textContent = 'Belum ada transaksi.';
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
      ? `${rows.length} dari ${data.transaksi.length} transaksi`
      : `${data.transaksi.length} transaksi`;

    tabelBody.textContent = '';
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'kosong';
      td.textContent = data.transaksi.length === 0
        ? 'Belum ada transaksi. Tambahkan transaksi pertama lewat formulir di atas.'
        : 'Tidak ada transaksi yang cocok dengan filter.';
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
      badge.textContent = t.jenis === 'masuk' ? 'Pemasukan' : 'Pengeluaran';
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
      btn.title = 'Hapus transaksi';
      btn.setAttribute('aria-label', `Hapus transaksi ${t.keterangan}`);
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
      empty.textContent = 'Grafik tren tampil setelah ada transaksi di dua hari berbeda.';
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
    svg.setAttribute('aria-label', 'Grafik garis saldo kumulatif per hari');

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
        { warna: cIncome, nilai: formatRupiah(p.saldo), label: 'saldo' }
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
      empty.textContent = 'Belum ada data untuk ditampilkan.';
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
    svg.setAttribute('aria-label', 'Grafik batang pemasukan dan pengeluaran per bulan');

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
      hit.setAttribute('aria-label', `${bulanLabel(r.bulan)}: pemasukan ${formatRupiah(r.masuk)}, pengeluaran ${formatRupiah(r.keluar)}`);
      const tampil = (clientX) => {
        const rect = svg.getBoundingClientRect();
        isiTooltip(tip, bulanLabel(r.bulan), [
          { warna: cIncome, nilai: formatRupiah(r.masuk), label: 'pemasukan' },
          { warna: cExpense, nilai: formatRupiah(r.keluar), label: 'pengeluaran' }
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
      ? `${terbesar.jenis === 'masuk' ? 'Pemasukan' : 'Pengeluaran'} · ${terbesar.keterangan}`
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
        setPesan('Gagal memuat data transaksi.', false);
      }
    } catch (err) {
      console.error('Failed to load transactions:', err);
      setPesan('Gagal menghubungkan ke server.', false);
    }
  }

  async function checkAuthAndRender() {
    try {
      const response = await fetch('/api/me');
      if (response.ok) {
        const data = await response.json();
        gateWrap.classList.remove('is-visible');
        app.classList.add('is-visible');
        document.getElementById('greeting').textContent = `Halo, ${data.username}. Berikut kondisi keuanganmu.`;
        document.getElementById('sidebar-username').textContent = data.username;
        document.getElementById('mobile-username').textContent = data.username;
        document.getElementById('setting-username').textContent = data.username;
        await muatUlang();
      } else {
        app.classList.remove('is-visible');
        gateWrap.classList.add('is-visible');
      }
    } catch (err) {
      console.error('Gagal memeriksa status login:', err);
      app.classList.remove('is-visible');
      gateWrap.classList.add('is-visible');
    }
  }

  // ------------------------------------------------------------------
  // Aksi: tambah, hapus, filter, logout
  // ------------------------------------------------------------------
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
        setPesan(hasil.error || 'Terjadi kesalahan.', false);
        return;
      }
      formTransaksi.keterangan.value = '';
      formTransaksi.jumlah.value = '';
      setPesan('Transaksi tersimpan.', true);
      renderAll(hasil);
    } catch (err) {
      console.error('Failed to submit transaction:', err);
      setPesan('Gagal menghubungkan ke server.', false);
    }
  });

  tabelBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('.hapus');
    if (!btn) return;
    const id = parseInt(btn.dataset.id, 10);
    if (isNaN(id)) return;
    if (!window.confirm('Hapus transaksi ini?')) return;

    setPesan('', true);
    try {
      const response = await fetch('/api/transactions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      const hasil = await response.json();
      if (!response.ok || hasil.error) {
        setPesan(hasil.error || 'Gagal menghapus transaksi.', false);
        return;
      }
      renderAll(hasil);
    } catch (err) {
      console.error('Failed to delete transaction:', err);
      setPesan('Gagal menghubungkan ke server.', false);
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

  async function logout() {
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      appData = null;
      checkAuthAndRender();
    }
  }
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('btn-logout-settings').addEventListener('click', logout);

  checkAuthAndRender();
});
