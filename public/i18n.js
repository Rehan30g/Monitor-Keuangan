// i18n: terapkan bahasa tersimpan sebelum render — pola sinkron yang sama
// dengan theme.js. Dimuat di <head> setiap halaman, tepat setelah theme.js.
// Default Bahasa Indonesia; pilihan disimpan di localStorage key "lang".
(function () {
  var LANGS = ['id', 'en', 'zh'];

  function bacaLang() {
    var l = null;
    try { l = localStorage.getItem('lang'); } catch (e) { l = null; }
    return LANGS.indexOf(l) >= 0 ? l : 'id';
  }

  var lang = bacaLang();

  var MONTHS = {
    id: ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'],
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    zh: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
  };

  // ------------------------------------------------------------------
  // Kamus UI (statis + dinamis). Kunci = namespace.pendek.
  // ------------------------------------------------------------------
  var D = {
    // Navigasi & shell
    'nav.ringkasan':   { id: 'Ringkasan', en: 'Overview', zh: '概览' },
    'nav.transaksi':   { id: 'Transaksi', en: 'Transactions', zh: '交易' },
    'nav.laporan':     { id: 'Laporan', en: 'Reports', zh: '报告' },
    'nav.pengaturan':  { id: 'Pengaturan', en: 'Settings', zh: '设置' },
    'nav.logout':      { id: 'Logout', en: 'Log out', zh: '退出登录' },
    'aria.navMain':    { id: 'Navigasi utama', en: 'Main navigation', zh: '主导航' },
    'aria.navBottom':  { id: 'Navigasi bawah', en: 'Bottom navigation', zh: '底部导航' },

    // Dokumen
    'doc.dashboard':   { id: 'Dashboard - UangKu', en: 'Dashboard - UangKu', zh: '仪表盘 - UangKu' },
    'doc.login':       { id: 'Login - Huzky.xyz', en: 'Log in - Huzky.xyz', zh: '登录 - Huzky.xyz' },
    'doc.register':    { id: 'Daftar - Huzky.xyz', en: 'Register - Huzky.xyz', zh: '注册 - Huzky.xyz' },
    'doc.verify':      { id: 'Verifikasi Kode - Huzky.xyz', en: 'Verify Code - Huzky.xyz', zh: '验证码 - Huzky.xyz' },
    'doc.linktg':      { id: 'Hubungkan Telegram - Huzky.xyz', en: 'Link Telegram - Huzky.xyz', zh: '绑定 Telegram - Huzky.xyz' },

    // Ringkasan
    'greeting.plain':  { id: 'Halo.', en: 'Hello.', zh: '你好。' },
    'greeting.full':   { id: 'Halo, {nama}. Berikut kondisi keuanganmu.', en: 'Hello, {nama}. Here is how your finances look.', zh: '你好，{nama}。这是你的财务状况。' },
    'stat.saldo':      { id: 'Saldo', en: 'Balance', zh: '余额' },
    'stat.masuk':      { id: 'Total pemasukan', en: 'Total income', zh: '总收入' },
    'stat.keluar':     { id: 'Total pengeluaran', en: 'Total expenses', zh: '总支出' },
    'stat.txRecorded': { id: '{n} transaksi tercatat', en: '{n} transactions recorded', zh: '已记录 {n} 笔交易' },
    'stat.txCount':    { id: '{n} transaksi', en: '{n} transactions', zh: '{n} 笔交易' },
    'chart.trendTitle': { id: 'Tren saldo', en: 'Balance trend', zh: '余额趋势' },
    'chart.trendNote': { id: 'Saldo kumulatif per hari', en: 'Cumulative daily balance', zh: '每日累计余额' },
    'chart.trendAria': { id: 'Grafik garis saldo kumulatif per hari', en: 'Line chart of cumulative daily balance', zh: '每日累计余额折线图' },
    'chart.bulanAria': { id: 'Grafik batang pemasukan dan pengeluaran per bulan', en: 'Bar chart of monthly income and expenses', zh: '每月收支柱状图' },
    'chart.emptyTrend': { id: 'Grafik tampil setelah ada transaksi di dua hari berbeda.', en: 'The chart appears once you have transactions on two different days.', zh: '在两个不同日期有交易后将显示图表。' },
    'chart.emptyData': { id: 'Belum ada data.', en: 'No data yet.', zh: '暂无数据。' },
    'recent.title':    { id: 'Transaksi terbaru', en: 'Recent transactions', zh: '最近交易' },
    'recent.viewAll':  { id: 'Lihat semua', en: 'View all', zh: '查看全部' },
    'empty.tx':        { id: 'Belum ada transaksi.', en: 'No transactions yet.', zh: '暂无交易。' },
    'empty.txAdd':     { id: 'Belum ada transaksi. Tambahkan lewat formulir di atas.', en: 'No transactions yet. Add one with the form above.', zh: '暂无交易。请使用上方表单添加。' },
    'empty.filter':    { id: 'Tidak ada yang cocok dengan filter.', en: 'Nothing matches the filter.', zh: '没有符合筛选条件的交易。' },
    'tt.saldo':        { id: 'saldo', en: 'balance', zh: '余额' },
    'tt.masuk':        { id: 'pemasukan', en: 'income', zh: '收入' },
    'tt.keluar':       { id: 'pengeluaran', en: 'expenses', zh: '支出' },

    // Transaksi
    'tx.sub':          { id: 'Catat dan kelola pemasukan & pengeluaran.', en: 'Record and manage income & expenses.', zh: '记录和管理收支。' },
    'tx.add':          { id: 'Tambah transaksi', en: 'Add transaction', zh: '添加交易' },
    'tx.jenis':        { id: 'Jenis', en: 'Type', zh: '类型' },
    'tx.masuk':        { id: 'Pemasukan', en: 'Income', zh: '收入' },
    'tx.keluar':       { id: 'Pengeluaran', en: 'Expense', zh: '支出' },
    'tx.ket':          { id: 'Keterangan', en: 'Description', zh: '说明' },
    'tx.ketPh':        { id: 'contoh: Gaji, Belanja', en: 'e.g. Salary, Groceries', zh: '例如：工资、购物' },
    'tx.jumlah':       { id: 'Jumlah (Rp)', en: 'Amount (Rp)', zh: '金额 (Rp)' },
    'tx.submit':       { id: 'Tambah', en: 'Add', zh: '添加' },
    'tx.close':        { id: 'Tutup', en: 'Close', zh: '关闭' },
    'tx.searchPh':     { id: 'Cari keterangan…', en: 'Search descriptions…', zh: '搜索说明…' },
    'aria.cariTx':     { id: 'Cari transaksi', en: 'Search transactions', zh: '搜索交易' },
    'aria.filterJenis': { id: 'Filter jenis', en: 'Filter by type', zh: '按类型筛选' },
    'filter.semua':    { id: 'Semua', en: 'All', zh: '全部' },
    'th.waktu':        { id: 'Waktu', en: 'Time', zh: '时间' },
    'th.jumlah':       { id: 'Jumlah', en: 'Amount', zh: '金额' },
    'th.bulan':        { id: 'Bulan', en: 'Month', zh: '月份' },
    'th.selisih':      { id: 'Selisih', en: 'Net', zh: '差额' },
    'tx.countFiltered': { id: '{shown} dari {total} transaksi', en: '{shown} of {total} transactions', zh: '{total} 笔交易中的 {shown} 笔' },
    'tx.hapusTitle':   { id: 'Hapus transaksi', en: 'Delete transaction', zh: '删除交易' },
    'tx.hapusAria':    { id: 'Hapus transaksi {ket}', en: 'Delete transaction {ket}', zh: '删除交易 {ket}' },
    'tx.hapusConfirm': { id: 'Hapus transaksi ini?', en: 'Delete this transaction?', zh: '删除这笔交易？' },

    // Laporan
    'lap.sub':         { id: 'Rekap bulanan dari riwayat transaksi.', en: 'Monthly recap from your transaction history.', zh: '根据交易记录生成的月度汇总。' },
    'lap.avgMasuk':    { id: 'Rata-rata pemasukan / bulan', en: 'Avg. income / month', zh: '月均收入' },
    'lap.avgKeluar':   { id: 'Rata-rata pengeluaran / bulan', en: 'Avg. expenses / month', zh: '月均支出' },
    'lap.terbesar':    { id: 'Transaksi terbesar', en: 'Largest transaction', zh: '最大交易' },
    'lap.chartTitle':  { id: 'Pemasukan vs pengeluaran per bulan', en: 'Income vs expenses by month', zh: '每月收支对比' },
    'lap.showTable':   { id: 'Tampilkan sebagai tabel', en: 'Show as table', zh: '以表格显示' },
    'lap.ariaBulan':   { id: '{bulan}: pemasukan {masuk}, pengeluaran {keluar}', en: '{bulan}: income {masuk}, expenses {keluar}', zh: '{bulan}：收入 {masuk}，支出 {keluar}' },

    // Pengaturan
    'set.sub':         { id: 'Akun dan preferensi tampilan.', en: 'Account and display preferences.', zh: '账户与显示偏好。' },
    'set.profil':      { id: 'Profil', en: 'Profile', zh: '个人资料' },
    'set.gantiFoto':   { id: 'Ubah', en: 'Change', zh: '更改' },
    'set.hapus':       { id: 'Hapus', en: 'Remove', zh: '删除' },
    'set.hapusFoto':   { id: 'Hapus foto', en: 'Remove photo', zh: '删除头像' },
    'set.nama':        { id: 'Nama panggilan', en: 'Display name', zh: '昵称' },
    'set.namaPh':      { id: 'mis. Kak Aldrick', en: 'e.g. Aldrick', zh: '例如：小李' },
    'set.simpan':      { id: 'Simpan', en: 'Save', zh: '保存' },
    'set.tampilan':    { id: 'Tampilan', en: 'Appearance', zh: '外观' },
    'set.tema':        { id: 'Tema', en: 'Theme', zh: '主题' },
    'set.temaDesc':    { id: '"Sistem" mengikuti pengaturan perangkat.', en: '"System" follows your device setting.', zh: '“系统”跟随设备设置。' },
    'aria.pilihTema':  { id: 'Pilih tema', en: 'Choose theme', zh: '选择主题' },
    'theme.terang':    { id: 'Terang', en: 'Light', zh: '浅色' },
    'theme.gelap':     { id: 'Gelap', en: 'Dark', zh: '深色' },
    'theme.sistem':    { id: 'Sistem', en: 'System', zh: '系统' },
    'set.bahasa':      { id: 'Bahasa', en: 'Language', zh: '语言' },
    'aria.pilihBahasa': { id: 'Pilih bahasa', en: 'Choose language', zh: '选择语言' },
    'set.akun':        { id: 'Akun', en: 'Account', zh: '账户' },
    'set.akunDesc':    { id: 'Akun yang sedang login.', en: 'Currently signed in.', zh: '当前登录的账户。' },
    'set.txTercatat':  { id: 'Transaksi tercatat', en: 'Transactions recorded', zh: '已记录交易' },
    'set.sesi':        { id: 'Sesi', en: 'Session', zh: '会话' },
    'set.sesiDesc':    { id: 'Keluar dari perangkat ini.', en: 'Sign out on this device.', zh: '在此设备上退出登录。' },
    'set.tgBot':       { id: 'Bot Telegram', en: 'Telegram bot', zh: 'Telegram 机器人' },
    'set.tgDesc':      { id: 'Catat transaksi lewat foto struk atau teks di Telegram.', en: 'Log transactions via receipt photos or text on Telegram.', zh: '通过 Telegram 发送小票照片或文字记账。' },
    'set.bukaBot':     { id: 'Buka Bot', en: 'Open Bot', zh: '打开机器人' },
    'set.statusKoneksi': { id: 'Status koneksi', en: 'Connection status', zh: '连接状态' },
    'set.putuskan':    { id: 'Putuskan', en: 'Disconnect', zh: '断开' },
    'set.autentikasi': { id: 'Autentikasi', en: 'Authentication', zh: '认证' },

    'set.patTitle':    { id: 'MCP', en: 'MCP', zh: 'MCP' },
    'set.patLabel':    { id: 'Token akses', en: 'Access token', zh: '访问令牌' },
    'set.patDesc':     { id: 'Hubungkan aplikasi atau agen AI yang mendukung MCP (Model Context Protocol) supaya bisa membaca dan mencatat transaksimu.', en: 'Connect any app or AI agent that supports MCP (Model Context Protocol) to read and log your transactions.', zh: '连接任何支持 MCP（模型上下文协议）的应用或 AI 代理，读取并记录你的交易。' },
    'set.patDocsLink': { id: 'Lihat panduan lengkap →', en: 'See full guide →', zh: '查看完整指南 →' },
    'set.patSkillLink': { id: 'Panduan untuk AI agent (SKILL.md) →', en: 'Guide for AI agents (SKILL.md) →', zh: 'AI 代理指南（SKILL.md）→' },
    'set.patUrlLabel': { id: 'URL server MCP', en: 'MCP server URL', zh: 'MCP 服务器网址' },
    'set.patLabelDesc': { id: 'Setiap aplikasi butuh token sendiri untuk terhubung.', en: 'Each app needs its own token to connect.', zh: '每个应用都需要自己的令牌才能连接。' },
    'set.patBuat':     { id: 'Buat Token Baru', en: 'Create New Token', zh: '创建新令牌' },
    'set.patKosong':   { id: 'Belum ada token dibuat.', en: 'No tokens created yet.', zh: '尚未创建任何令牌。' },
    'set.patBuatTitle': { id: 'Buat token baru', en: 'Create new token', zh: '创建新令牌' },
    'set.patBuatMsg':  { id: 'Beri nama token ini agar mudah dikenali nanti, mis. alat atau agen AI mana yang memakainya.', en: 'Give this token a name so you can recognize it later, e.g. which tool or AI agent uses it.', zh: '为此令牌命名，方便日后识别，例如它被哪个工具或 AI 代理使用。' },
    'set.patLabelInput': { id: 'Nama token', en: 'Token name', zh: '令牌名称' },
    'set.patLabelPh':  { id: 'mis. Aplikasi AI di laptop kerja', en: 'e.g. AI app on my work laptop', zh: '例如：工作笔记本上的 AI 应用' },
    'set.patBuatBtn':  { id: 'Buat Token', en: 'Create Token', zh: '创建令牌' },
    'set.patGagal':    { id: 'Gagal membuat token. Coba lagi.', en: 'Failed to create token. Please try again.', zh: '创建令牌失败，请重试。' },
    'set.patRevealTitle': { id: 'Token dibuat', en: 'Token created', zh: '令牌已创建' },
    'set.patRevealWarn': { id: 'Simpan sekarang — token ini tidak akan ditampilkan lagi setelah ditutup.', en: 'Save it now — this token will not be shown again after you close this window.', zh: '请立即保存——关闭此窗口后将无法再次查看该令牌。' },
    'set.patSalin':    { id: 'Salin', en: 'Copy', zh: '复制' },
    'set.patTersalin': { id: 'Tersalin ke clipboard.', en: 'Copied to clipboard.', zh: '已复制到剪贴板。' },
    'set.patGagalSalin': { id: 'Gagal menyalin. Salin manual dari kotak di atas.', en: 'Copy failed. Please copy it manually from the box above.', zh: '复制失败，请手动从上方框中复制。' },
    'set.patTersalinSingkat': { id: 'Tersalin!', en: 'Copied!', zh: '已复制！' },
    'set.patSelesai':  { id: 'Selesai, sudah disimpan', en: 'Done, I have saved it', zh: '完成，已保存' },
    'set.patCabut':    { id: 'Cabut', en: 'Revoke', zh: '撤销' },
    'set.patCabutTitle': { id: 'Cabut token', en: 'Revoke token', zh: '撤销令牌' },
    'set.patCabutMsg': { id: 'Yakin ingin mencabut token "{label}"? Alat yang memakainya akan langsung kehilangan akses.', en: 'Revoke the token "{label}"? Any tool using it will lose access immediately.', zh: '确定要撤销令牌 “{label}” 吗？使用它的工具将立即失去访问权限。' },
    'set.patCabutBtn': { id: 'Cabut token', en: 'Revoke token', zh: '撤销令牌' },
    'set.patBelumDipakai': { id: 'Belum pernah dipakai', en: 'Never used', zh: '从未使用' },
    'set.patMeta':     { id: 'Dibuat {dibuat} · Terakhir dipakai: {dipakai}', en: 'Created {dibuat} · Last used: {dipakai}', zh: '创建于 {dibuat} · 最后使用：{dipakai}' },
    'set.tentang':     { id: 'Tentang', en: 'About', zh: '关于' },
    'aria.subtabs':    { id: 'Bagian pengaturan', en: 'Settings sections', zh: '设置分区' },
    'set.infoAkun':    { id: 'Informasi akun', en: 'Account information', zh: '账户信息' },
    'set.kataSandi':   { id: 'Kata sandi', en: 'Password', zh: '密码' },
    'set.unduhData':   { id: 'Unduh data Anda', en: 'Download your data', zh: '下载你的数据' },
    'set.unduhLabel':  { id: 'Ekspor transaksi', en: 'Export transactions', zh: '导出交易' },
    'set.unduhDesc':   { id: 'Kirim salinan seluruh transaksi kamu (CSV) ke email.', en: 'Email yourself a copy of all your transactions (CSV).', zh: '将你的全部交易记录（CSV）发送到你的邮箱。' },
    'set.unduhBtn':    { id: 'Kirim ke email', en: 'Send to email', zh: '发送到邮箱' },
    'set.ubah':        { id: 'Ubah', en: 'Change', zh: '更改' },
    'set.emailDesc':   { id: 'Email akun untuk verifikasi dan notifikasi.', en: 'Account email for verification and notifications.', zh: '用于验证和通知的账户邮箱。' },
    'set.gantiEmail':  { id: 'Ganti email', en: 'Change email', zh: '更改邮箱' },
    'set.emailBaru':   { id: 'Email baru', en: 'New email', zh: '新邮箱' },
    'set.emailStep1':  { id: 'Kode verifikasi akan dikirim ke email baru kamu.', en: 'A verification code will be sent to your new email.', zh: '验证码将发送到你的新邮箱。' },
    'set.emailStep2':  { id: 'Masukkan kode 6 digit yang dikirim ke email baru kamu.', en: 'Enter the 6-digit code sent to your new email.', zh: '请输入发送到新邮箱的 6 位验证码。' },
    'set.kirimKode':   { id: 'Kirim kode', en: 'Send code', zh: '发送验证码' },
    'set.gantiPw':     { id: 'Ganti password', en: 'Change password', zh: '修改密码' },
    'set.gantiPwDesc': { id: 'Perbarui password untuk login.', en: 'Update the password you sign in with.', zh: '更新用于登录的密码。' },
    'set.pwSaatIni':   { id: 'Password saat ini', en: 'Current password', zh: '当前密码' },
    'set.pwBaru':      { id: 'Password baru', en: 'New password', zh: '新密码' },
    'cf.batal':        { id: 'Batal', en: 'Cancel', zh: '取消' },
    'cf.logoutMsg':    { id: 'Yakin ingin keluar dari perangkat ini?', en: 'Are you sure you want to log out of this device?', zh: '确定要在此设备上退出登录吗？' },
    'cf.exportMsg':    { id: 'Kirim salinan seluruh transaksi kamu (CSV) ke email akunmu?', en: 'Send a copy of all your transactions (CSV) to your account email?', zh: '将你全部交易记录（CSV）的副本发送到账户邮箱？' },
    'set.redZone':     { id: 'Zona merah', en: 'Red zone', zh: '危险区域' },
    'set.hapusAkun':   { id: 'Hapus akun', en: 'Delete account', zh: '删除账户' },
    'set.hapusAkunDesc': { id: 'Menghapus akun dan seluruh data secara permanen. Tidak bisa dibatalkan.', en: 'Permanently deletes your account and all its data. This cannot be undone.', zh: '永久删除账户及全部数据，无法撤销。' },
    'set.hapusAkunLabel': { id: 'Konfirmasi password', en: 'Confirm password', zh: '确认密码' },
    'set.hapusAkunBtn': { id: 'Hapus akun saya', en: 'Delete my account', zh: '删除我的账户' },
    'set.hapusAkunConfirm': { id: 'Yakin ingin menghapus akun ini secara permanen? Semua data akan hilang dan tidak bisa dikembalikan.', en: 'Permanently delete this account? All data will be lost and cannot be recovered.', zh: '确定要永久删除此账户吗？所有数据将丢失且无法恢复。' },
    'about.desc':      { id: 'UangKu — pencatat keuangan pribadi yang sederhana.', en: 'UangKu — a simple personal finance tracker.', zh: 'UangKu——简洁的个人记账应用。' },
    'about.madeBy':    { id: 'Dibuat oleh', en: 'Made by', zh: '作者' },
    'about.source':    { id: 'Kode sumber', en: 'Source code', zh: '源代码' },
    'about.versi':     { id: 'Versi', en: 'Version', zh: '版本' },
    'tg.checking':     { id: 'Memeriksa status…', en: 'Checking status…', zh: '正在检查状态…' },
    'tg.connectedAs':  { id: 'Terhubung sebagai {name}.', en: 'Connected as {name}.', zh: '已连接为 {name}。' },
    'tg.connected':    { id: 'Terhubung.', en: 'Connected.', zh: '已连接。' },
    'tg.notConnected': { id: 'Belum terhubung. Ketik /login di bot.', en: 'Not connected. Send /login to the bot.', zh: '尚未连接。请在机器人中发送 /login。' },
    'tg.statusFail':   { id: 'Gagal memuat status.', en: 'Could not load status.', zh: '状态加载失败。' },

    // Pesan klien
    'msg.tersimpan':   { id: 'Tersimpan.', en: 'Saved.', zh: '已保存。' },
    'msg.txSaved':     { id: 'Transaksi tersimpan.', en: 'Transaction saved.', zh: '交易已保存。' },
    'msg.loadFail':    { id: 'Gagal memuat data transaksi.', en: 'Could not load transactions.', zh: '交易数据加载失败。' },
    'msg.netFail':     { id: 'Gagal menghubungkan ke server.', en: 'Could not reach the server.', zh: '无法连接服务器。' },
    'msg.err':         { id: 'Terjadi kesalahan.', en: 'Something went wrong.', zh: '发生错误。' },
    'msg.delFail':     { id: 'Gagal menghapus transaksi.', en: 'Could not delete the transaction.', zh: '删除交易失败。' },
    'msg.namaFail':    { id: 'Gagal menyimpan nama panggilan.', en: 'Could not save display name.', zh: '昵称保存失败。' },
    'msg.pwSaved':     { id: 'Password berhasil diubah.', en: 'Password changed successfully.', zh: '密码修改成功。' },
    'msg.pwFail':      { id: 'Gagal mengubah password.', en: 'Could not change the password.', zh: '密码修改失败。' },
    'msg.fmtFoto':     { id: 'Format harus PNG, JPEG, atau WEBP.', en: 'Must be PNG, JPEG, or WEBP.', zh: '格式须为 PNG、JPEG 或 WEBP。' },
    'msg.fotoBesar':   { id: 'Ukuran foto maksimal 1.5 MB.', en: 'Photo must be under 1.5 MB.', zh: '照片不能超过 1.5 MB。' },
    'msg.fotoFail':    { id: 'Gagal mengunggah foto.', en: 'Could not upload the photo.', zh: '头像上传失败。' },
    'msg.fotoSaved':   { id: 'Foto profil tersimpan.', en: 'Profile photo saved.', zh: '头像已保存。' },
    'avatar.alt':      { id: 'Foto profil', en: 'Profile photo', zh: '头像' },

    // Auth
    'auth.username':   { id: 'Username', en: 'Username', zh: '用户名' },
    'auth.password':   { id: 'Password', en: 'Password', zh: '密码' },
    'auth.email':      { id: 'Email', en: 'Email', zh: '邮箱' },
    'auth.login.h1':   { id: 'Login', en: 'Log in', zh: '登录' },
    'auth.login.sub':  { id: 'Masuk untuk melihat dasbor keuanganmu.', en: 'Sign in to view your finance dashboard.', zh: '登录以查看你的财务仪表盘。' },
    'auth.login.btn':  { id: 'Login', en: 'Log in', zh: '登录' },
    'auth.login.alt':  { id: 'Belum punya akun?', en: 'No account yet?', zh: '还没有账户？' },
    'auth.login.altLink': { id: 'Daftar di sini', en: 'Register here', zh: '点此注册' },
    'auth.reg.h1':     { id: 'Daftar Akun', en: 'Create Account', zh: '注册账户' },
    'auth.reg.sub':    { id: 'Buat akun baru untuk mulai mencatat keuangan.', en: 'Create an account to start tracking your finances.', zh: '创建账户，开始记录你的财务。' },
    'auth.reg.btn':    { id: 'Daftar', en: 'Register', zh: '注册' },
    'auth.reg.alt':    { id: 'Sudah punya akun?', en: 'Already have an account?', zh: '已有账户？' },
    'auth.reg.altLink': { id: 'Login di sini', en: 'Log in here', zh: '点此登录' },
    'auth.verify.h1':  { id: 'Verifikasi Kode', en: 'Verify Code', zh: '输入验证码' },
    'auth.verify.desc': { id: 'Masukkan kode 6 digit yang dikirim ke email kamu.', en: 'Enter the 6-digit code sent to your email.', zh: '请输入发送到你邮箱的 6 位验证码。' },
    'auth.verify.label': { id: 'Kode Verifikasi', en: 'Verification code', zh: '验证码' },
    'auth.verify.btn': { id: 'Verifikasi', en: 'Verify', zh: '验证' },
    'auth.verify.resend': { id: 'Kirim ulang kode', en: 'Resend code', zh: '重新发送验证码' },
    'auth.regFail':    { id: 'Registrasi gagal.', en: 'Registration failed.', zh: '注册失败。' },
    'auth.loginFail':  { id: 'Login gagal.', en: 'Login failed.', zh: '登录失败。' },
    'auth.verifyFail': { id: 'Verifikasi gagal.', en: 'Verification failed.', zh: '验证失败。' },
    'auth.resendFail': { id: 'Gagal mengirim ulang kode.', en: 'Could not resend the code.', zh: '重新发送失败。' },
    'auth.codeSent':   { id: 'Kode baru telah dikirim.', en: 'A new code has been sent.', zh: '新验证码已发送。' },
    'linktg.h1':       { id: 'Hubungkan Telegram', en: 'Link Telegram', zh: '绑定 Telegram' },
    'linktg.checking': { id: 'Memeriksa status login...', en: 'Checking login status...', zh: '正在检查登录状态…' },
    'linktg.btn':      { id: 'Hubungkan Akun', en: 'Link Account', zh: '绑定账户' },
    'linktg.sub':      { id: 'Konfirmasi koneksi antara akun UangKu kamu dan chat Telegram ini.', en: 'Confirm the connection between your UangKu account and this Telegram chat.', zh: '确认将你的 UangKu 账户与此 Telegram 会话绑定。' },
    'linktg.confirm':  { id: 'Hubungkan chat Telegram ini ke akun di atas?', en: 'Link this Telegram chat to the account above?', zh: '将此 Telegram 会话绑定到上面的账户？' },
    'linktg.hint':     { id: 'Setelah terhubung, kamu bisa mencatat transaksi langsung dari Telegram.', en: 'Once linked, you can log transactions straight from Telegram.', zh: '绑定后即可直接在 Telegram 中记账。' },
    'linktg.invalid':  { id: 'Link tidak valid — token tidak ditemukan.', en: 'Invalid link — token not found.', zh: '链接无效——未找到令牌。' },
    'linktg.failCheck': { id: 'Gagal memeriksa status login.', en: 'Could not check login status.', zh: '无法检查登录状态。' },
    'linktg.connecting': { id: 'Menghubungkan...', en: 'Linking...', zh: '正在绑定…' },
    'linktg.success':  { id: 'Berhasil terhubung! Kembali ke Telegram.', en: 'Linked successfully! Return to Telegram.', zh: '绑定成功！请返回 Telegram。' },
    'linktg.fail':     { id: 'Gagal menghubungkan.', en: 'Linking failed.', zh: '绑定失败。' },
    'linktg.failNet':  { id: 'Gagal menghubungkan ke server.', en: 'Could not reach the server.', zh: '无法连接服务器。' },

    // Landing
    'landing.masuk':   { id: 'Masuk', en: 'Log in', zh: '登录' },
    'landing.daftar':  { id: 'Daftar', en: 'Register', zh: '注册' },
    'landing.openDash': { id: 'Buka Dashboard', en: 'Open Dashboard', zh: '打开仪表盘' },
    'landing.eyebrow': { id: 'Pencatatan keuangan pribadi', en: 'Personal finance tracking', zh: '个人财务记录' },
    'landing.title1':  { id: 'Uang masuk, uang keluar —', en: 'Money in, money out —', zh: '收入、支出——' },
    'landing.title2':  { id: 'semua tercatat rapi.', en: 'all neatly recorded.', zh: '一切井井有条。' },
    'landing.heroSub': { id: 'Catat pemasukan dan pengeluaran, pantau tren saldo, dan baca laporan bulanan dalam satu dasbor. Malas mengetik? Kirim foto struk ke bot Telegram — AI yang mencatatnya untuk Anda.', en: 'Track income and expenses, watch your balance trend, and read monthly reports in one dashboard. Too lazy to type? Send a receipt photo to the Telegram bot — AI logs it for you.', zh: '在一个仪表盘中记录收支、跟踪余额趋势、查看月度报告。懒得打字？把小票照片发给 Telegram 机器人，AI 会自动帮你记账。' },
    'landing.ctaStart': { id: 'Mulai gratis', en: 'Start free', zh: '免费开始' },
    'landing.ctaLogin': { id: 'Masuk ke akun', en: 'Sign in', zh: '登录账户' },
    'landing.chartTag': { id: '6 bulan terakhir', en: 'Last 6 months', zh: '近 6 个月' },
    'landing.featTitle': { id: 'Semua yang perlu, tanpa yang ribet', en: 'Everything you need, nothing you don’t', zh: '该有的都有，多余的没有' },
    'landing.featSub': { id: 'Empat hal yang dikerjakan UangKu dengan baik.', en: 'Four things UangKu does well.', zh: 'UangKu 做好的四件事。' },
    'landing.f1h':     { id: 'Dasbor yang jelas', en: 'A clear dashboard', zh: '清晰的仪表盘' },
    'landing.f1p':     { id: 'Ringkasan saldo, pemasukan, dan pengeluaran dalam sekali lihat. Grafik tren saldo, laporan bulanan pemasukan vs pengeluaran, plus pencarian dan filter transaksi.', en: 'Balance, income, and expenses at a glance. Balance trend charts, monthly income vs expense reports, plus transaction search and filters.', zh: '余额、收入、支出一目了然。余额趋势图、月度收支报告，以及交易搜索和筛选。' },
    'landing.f2h':     { id: 'Catat lewat Telegram', en: 'Log via Telegram', zh: '通过 Telegram 记账' },
    'landing.f2p':     { id: 'Kirim foto struk, nota, atau sekadar catatan teks ke bot Telegram. AI membacanya dan langsung mencatatnya sebagai transaksi di dasbor — tanpa input manual.', en: 'Send a receipt photo, an invoice, or a plain text note to the Telegram bot. AI reads it and logs it straight to your dashboard — no manual input.', zh: '把小票、发票照片或一句文字发给 Telegram 机器人。AI 读取后直接记入仪表盘，无需手动输入。' },
    'landing.f3h':     { id: 'Aman secara bawaan', en: 'Secure by default', zh: '默认安全' },
    'landing.f3p':     { id: 'Verifikasi email saat daftar, captcha di form masuk, notifikasi email setiap ada login baru, dan proteksi brute-force otomatis. Data keuangan Anda hanya untuk Anda.', en: 'Email verification at sign-up, captcha on the login form, email alerts on every new login, and automatic brute-force protection. Your financial data is yours alone.', zh: '注册时邮箱验证，登录表单带人机验证，每次新登录都有邮件提醒，并自动防暴力破解。你的财务数据只属于你。' },
    'landing.f4h':     { id: 'Terang atau gelap', en: 'Light or dark', zh: '浅色或深色' },
    'landing.f4p':     { id: 'Tampilan mengikuti tema perangkat Anda secara otomatis — atau atur sendiri mode terang/gelap di pengaturan. Nyaman dilihat siang maupun malam.', en: 'The interface follows your device theme automatically — or set light/dark mode yourself in settings. Comfortable day and night.', zh: '界面自动跟随设备主题，也可以在设置中自行选择浅色/深色模式。白天夜晚都舒适。' },
    'landing.stepsTitle': { id: 'Mulai dalam tiga langkah', en: 'Get started in three steps', zh: '三步开始' },
    'landing.s1h':     { id: 'Daftar & verifikasi', en: 'Register & verify', zh: '注册并验证' },
    'landing.s1p':     { id: 'Buat akun dengan email Anda, lalu konfirmasi lewat tautan verifikasi. Kurang dari satu menit.', en: 'Create an account with your email, then confirm via the verification link. Under a minute.', zh: '用邮箱创建账户，通过验证链接确认。不到一分钟。' },
    'landing.s2h':     { id: 'Catat transaksi', en: 'Log transactions', zh: '记录交易' },
    'landing.s2p':     { id: 'Input manual di dasbor, atau hubungkan bot Telegram dan cukup kirim foto struk belanja Anda.', en: 'Enter them manually in the dashboard, or connect the Telegram bot and just send a photo of your receipt.', zh: '在仪表盘手动输入，或绑定 Telegram 机器人，直接发送小票照片。' },
    'landing.s3h':     { id: 'Pantau & evaluasi', en: 'Monitor & review', zh: '跟踪与复盘' },
    'landing.s3p':     { id: 'Lihat ke mana uang Anda pergi lewat grafik tren dan laporan bulanan — lalu ambil keputusan yang lebih baik.', en: 'See where your money goes with trend charts and monthly reports — then make better decisions.', zh: '通过趋势图和月度报告了解钱花在哪里，做出更好的决策。' },
    'landing.ctaH':    { id: 'Keuangan yang rapi dimulai dari catatan yang rapi.', en: 'Tidy finances start with tidy records.', zh: '井然有序的财务，从整洁的记录开始。' },
    'landing.ctaP':    { id: 'Gratis, tanpa ribet. Daftar sekarang dan mulai catat transaksi pertama Anda hari ini.', en: 'Free and hassle-free. Sign up now and log your first transaction today.', zh: '免费又省心。现在注册，今天就记下你的第一笔交易。' },
    'landing.ctaReg':  { id: 'Daftar sekarang', en: 'Sign up now', zh: '立即注册' },
    'landing.ctaHave': { id: 'Saya sudah punya akun', en: 'I already have an account', zh: '我已有账户' }
  };

  // ------------------------------------------------------------------
  // Pesan tetap dari API (string Indonesia persis → terjemahan).
  // Fallback aman: string yang tak dikenal ditampilkan apa adanya.
  // ------------------------------------------------------------------
  var SERVER = {
    'Akun terkunci sementara. Coba lagi nanti.': { en: 'Account temporarily locked. Try again later.', zh: '账户已被暂时锁定，请稍后再试。' },
    'Alamat email tidak valid.': { en: 'Invalid email address.', zh: '邮箱地址无效。' },
    'Belum login.': { en: 'Not logged in.', zh: '尚未登录。' },
    'Data gambar tidak valid.': { en: 'Invalid image data.', zh: '图片数据无效。' },
    'Email belum diverifikasi. Kode verifikasi baru telah dikirim.': { en: 'Email not verified yet. A new verification code has been sent.', zh: '邮箱尚未验证，新的验证码已发送。' },
    'Format gambar harus PNG, JPEG, atau WEBP.': { en: 'Image must be PNG, JPEG, or WEBP.', zh: '图片格式须为 PNG、JPEG 或 WEBP。' },
    'ID transaksi tidak valid.': { en: 'Invalid transaction ID.', zh: '交易 ID 无效。' },
    'Kode salah, kedaluwarsa, atau sudah dipakai.': { en: 'Code is wrong, expired, or already used.', zh: '验证码错误、已过期或已被使用。' },
    'Link tidak valid atau sudah kedaluwarsa.': { en: 'Link is invalid or has expired.', zh: '链接无效或已过期。' },
    'Nama panggilan harus 1-40 karakter.': { en: 'Display name must be 1-40 characters.', zh: '昵称须为 1-40 个字符。' },
    'Password minimal 8 karakter.': { en: 'Password must be at least 8 characters.', zh: '密码至少 8 个字符。' },
    'Permintaan tidak valid.': { en: 'Invalid request.', zh: '请求无效。' },
    'Sesi tidak valid atau kedaluwarsa.': { en: 'Session is invalid or expired.', zh: '会话无效或已过期。' },
    'Terjadi kesalahan pada server.': { en: 'A server error occurred.', zh: '服务器发生错误。' },
    'Terlalu banyak percobaan. Coba lagi nanti.': { en: 'Too many attempts. Try again later.', zh: '尝试次数过多，请稍后再试。' },
    'Terlalu banyak permintaan kirim ulang. Coba lagi nanti.': { en: 'Too many resend requests. Try again later.', zh: '重发请求过多，请稍后再试。' },
    'Terlalu banyak permintaan. Coba lagi nanti.': { en: 'Too many requests. Try again later.', zh: '请求过多，请稍后再试。' },
    'Ukuran foto terlalu besar (maks 1.5 MB).': { en: 'Photo is too large (max 1.5 MB).', zh: '照片过大（最大 1.5 MB）。' },
    'Username atau email sudah digunakan.': { en: 'Username or email is already in use.', zh: '用户名或邮箱已被使用。' },
    'Username atau password salah.': { en: 'Wrong username or password.', zh: '用户名或密码错误。' },
    'Username harus 3-32 karakter, hanya huruf/angka/underscore.': { en: 'Username must be 3-32 characters: letters, numbers, or underscores only.', zh: '用户名须为 3-32 个字符，仅限字母、数字或下划线。' },
    'Verifikasi captcha gagal. Silakan coba lagi.': { en: 'Captcha verification failed. Please try again.', zh: '人机验证失败，请重试。' },
    'Akun Telegram berhasil diputus.': { en: 'Telegram account disconnected.', zh: 'Telegram 账户已断开。' },
    'Chat Telegram berhasil dihubungkan ke akun kamu.': { en: 'Telegram chat linked to your account.', zh: 'Telegram 会话已绑定到你的账户。' },
    'Email berhasil diverifikasi. Silakan login.': { en: 'Email verified. Please log in.', zh: '邮箱验证成功，请登录。' },
    'Foto profil dihapus.': { en: 'Profile photo removed.', zh: '头像已删除。' },
    'Foto profil tersimpan.': { en: 'Profile photo saved.', zh: '头像已保存。' },
    'Kode baru telah dikirim ke email kamu.': { en: 'A new code has been sent to your email.', zh: '新验证码已发送到你的邮箱。' },
    'Kode verifikasi telah dikirim ke email kamu.': { en: 'A verification code has been sent to your email.', zh: '验证码已发送到你的邮箱。' },
    'Login berhasil.': { en: 'Logged in successfully.', zh: '登录成功。' },
    'Logout berhasil.': { en: 'Logged out successfully.', zh: '已退出登录。' },
    'Nama panggilan tersimpan.': { en: 'Display name saved.', zh: '昵称已保存。' },
    'Registrasi berhasil. Kode verifikasi telah dikirim ke email kamu.': { en: 'Registration successful. A verification code has been sent to your email.', zh: '注册成功，验证码已发送到你的邮箱。' },
    'Jenis transaksi tidak dikenal.': { en: 'Unknown transaction type.', zh: '未知的交易类型。' },
    'Jumlah harus berupa angka positif yang valid.': { en: 'Amount must be a valid positive number.', zh: '金额必须是有效的正数。' },
    'Transaksi tidak ditemukan atau tidak berhak dihapus.': { en: 'Transaction not found or you cannot delete it.', zh: '未找到交易或无权删除。' },
    'Data kamu sedang dikirim ke email — cek inbox dalam beberapa menit.': { en: 'Your data is being sent to your email — check your inbox in a few minutes.', zh: '你的数据正在发送到你的邮箱——请几分钟后查收。' },
    'Akun berhasil dihapus.': { en: 'Account deleted.', zh: '账户已删除。' },
    'Password salah.': { en: 'Wrong password.', zh: '密码错误。' },
    'Email baru sama dengan email saat ini.': { en: 'The new email is the same as your current email.', zh: '新邮箱与当前邮箱相同。' },
    'Email tersebut sudah digunakan akun lain.': { en: 'That email is already used by another account.', zh: '该邮箱已被其他账户使用。' },
    'Kode verifikasi telah dikirim ke email baru kamu.': { en: 'A verification code has been sent to your new email.', zh: '验证码已发送到你的新邮箱。' },
    'Email berhasil diubah.': { en: 'Email changed successfully.', zh: '邮箱修改成功。' }
  };

  function t(key, vars) {
    var e = D[key];
    var s = e ? (e[lang] != null ? e[lang] : e.id) : key;
    if (vars) {
      for (var k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    }
    return s;
  }

  function tServer(str) {
    if (typeof str !== 'string' || !str) return str || '';
    if (lang === 'id') return str;
    var e = SERVER[str];
    return (e && e[lang]) ? e[lang] : str;
  }

  function apply(root) {
    root = root || document;
    var i, els;
    els = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
    els = root.querySelectorAll('[data-i18n-placeholder]');
    for (i = 0; i < els.length; i++) els[i].setAttribute('placeholder', t(els[i].getAttribute('data-i18n-placeholder')));
    els = root.querySelectorAll('[data-i18n-title]');
    for (i = 0; i < els.length; i++) els[i].setAttribute('title', t(els[i].getAttribute('data-i18n-title')));
    els = root.querySelectorAll('[data-i18n-aria]');
    for (i = 0; i < els.length; i++) els[i].setAttribute('aria-label', t(els[i].getAttribute('data-i18n-aria')));
  }

  function setLang(l) {
    if (LANGS.indexOf(l) < 0) return;
    lang = l;
    try { localStorage.setItem('lang', l); } catch (e) { /* abaikan */ }
    document.documentElement.lang = l;
    apply();
    window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: l } }));
  }

  // <html lang> benar sejak sebelum paint; teks diganti begitu DOM siap.
  document.documentElement.lang = lang;
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { apply(); });
  } else {
    apply();
  }

  window.t = t;
  window.tServer = tServer;
  window.getLang = function () { return lang; };
  window.setLang = setLang;
  window.applyI18n = apply;
  window.tMonths = function () { return MONTHS[lang] || MONTHS.id; };
})();
