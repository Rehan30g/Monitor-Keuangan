import db from './db.js';

export function formatRupiah(angka) {
  const tanda = angka < 0 ? '-' : '';
  const absAngka = Math.abs(Math.floor(angka));
  const formatted = String(absAngka).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${tanda}Rp ${formatted}`;
}

export function getTransactions(userId) {
  const stmt = db.prepare(
    `SELECT * FROM transactions WHERE userId = ? ORDER BY id DESC`
  );
  const rows = stmt.all(userId);

  let pemasukan = 0;
  let pengeluaran = 0;

  const formattedRows = rows.map(r => {
    if (r.jenis === 'masuk') {
      pemasukan += r.jumlah;
    } else if (r.jenis === 'keluar') {
      pengeluaran += r.jumlah;
    }
    return {
      id: r.id,
      jenis: r.jenis,
      keterangan: r.keterangan,
      jumlah: r.jumlah,
      jumlah_format: formatRupiah(r.jumlah),
      waktu: r.waktu
    };
  });

  const saldo = pemasukan - pengeluaran;

  return {
    transaksi: formattedRows,
    ringkasan: {
      pemasukan: formatRupiah(pemasukan),
      pengeluaran: formatRupiah(pengeluaran),
      saldo: formatRupiah(saldo)
    }
  };
}

export function addTransaction(userId, jenis, keterangan, jumlah) {
  const parsedJumlah = parseInt(jumlah, 10);
  if (isNaN(parsedJumlah) || parsedJumlah <= 0) {
    return { error: 'Jumlah harus berupa angka positif yang valid.' };
  }
  if (jenis !== 'masuk' && jenis !== 'keluar') {
    return { error: 'Jenis transaksi tidak dikenal.' };
  }

  const ket = (keterangan || '').trim() || '(tanpa keterangan)';
  
  // Format current local time: YYYY-MM-DD HH:MM:SS
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const waktu = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
                `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const stmt = db.prepare(
    `INSERT INTO transactions (userId, jenis, keterangan, jumlah, waktu) VALUES (?, ?, ?, ?, ?)`
  );
  stmt.run(userId, jenis, ket, parsedJumlah, waktu);

  return getTransactions(userId);
}

export function deleteTransaction(userId, id) {
  // Ensure the transaction belongs to the userId before deleting
  const stmtCheck = db.prepare(
    `SELECT id FROM transactions WHERE id = ? AND userId = ?`
  );
  const exists = stmtCheck.get(id, userId);

  if (!exists) {
    return { error: 'Transaksi tidak ditemukan atau tidak berhak dihapus.' };
  }

  const stmtDelete = db.prepare(
    `DELETE FROM transactions WHERE id = ? AND userId = ?`
  );
  stmtDelete.run(id, userId);

  return getTransactions(userId);
}
