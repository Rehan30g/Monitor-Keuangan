// Terapkan tema tersimpan sebelum halaman dirender (hindari flash).
// Dimuat sinkron di <head>. CSP tidak mengizinkan inline script,
// jadi logika ini hidup di file terpisah.
(function () {
  var SURFACE_LIGHT = '#fcfcfb';
  var SURFACE_DARK = '#1a1a19';

  function temaTersimpan() {
    var t;
    try { t = localStorage.getItem('theme'); } catch (e) { t = null; }
    return (t === 'light' || t === 'dark') ? t : 'system';
  }

  function resolvedIsDark(pilihan) {
    if (pilihan === 'dark') return true;
    if (pilihan === 'light') return false;
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  // Warna status bar / address bar (dan, di beberapa browser, bar navigasi sistem
  // edge-to-edge) mengikuti --surface yang sama dipakai title bar & tab bar app.
  function warnaMeta() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    return meta;
  }

  function terapkan(pilihan) {
    if (pilihan === 'light' || pilihan === 'dark') {
      document.documentElement.setAttribute('data-theme', pilihan);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    warnaMeta().setAttribute('content', resolvedIsDark(pilihan) ? SURFACE_DARK : SURFACE_LIGHT);
  }

  terapkan(temaTersimpan());

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (temaTersimpan() === 'system') terapkan('system');
    });
  }

  // Dipakai script.js saat user ganti tema manual di Pengaturan, supaya
  // warna bar ikut berubah seketika tanpa reload.
  window.terapkanThemeColor = terapkan;
})();
