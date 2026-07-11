// Terapkan tema tersimpan sebelum halaman dirender (hindari flash).
// Dimuat sinkron di <head>. CSP tidak mengizinkan inline script,
// jadi logika ini hidup di file terpisah.
(function () {
  var t;
  try { t = localStorage.getItem('theme'); } catch (e) { t = null; }
  if (t === 'light' || t === 'dark') {
    document.documentElement.setAttribute('data-theme', t);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
})();
