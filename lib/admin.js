import crypto from 'crypto';
import db from './db.js';
import { isMfaEnabled } from './mfa.js';
import { listConnectedClients } from './oauth-store.js';

// Kolom user yang aman diekspos ke panel admin. passwordHash TIDAK PERNAH
// masuk daftar ini — jangan pernah SELECT * lalu diteruskan ke klien.
const SAFE_USER_COLUMNS =
  'id, username, email, createdAt, emailVerified, role, deletedAt, failedLoginCount, lockedUntil';

// --- Perekam riwayat (dipanggil dari call site yang sudah ada) ------------

// Dipanggil dari auth.updateEmail SEBELUM email ditimpa: simpan email lama.
function recordEmailHistory(userId, oldEmail) {
  db.prepare(
    `INSERT INTO email_history (id, userId, oldEmail, changedAt) VALUES (?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, oldEmail, Date.now());
}

// Dipanggil dari auth.updatePassword setiap password benar-benar diganti.
// `via`: 'self' | 'reset' | 'admin_reset'. Tanpa material password apa pun.
function recordPasswordChange(userId, via) {
  db.prepare(
    `INSERT INTO password_change_log (id, userId, changedAt, changedVia) VALUES (?, ?, ?, ?)`
  ).run(crypto.randomUUID(), userId, Date.now(), via);
}

// Dipanggil di setiap kesimpulan percobaan login (sukses & gagal).
function recordLoginHistory({ userId, ip, userAgent, success }) {
  db.prepare(
    `INSERT INTO login_history (id, userId, occurredAt, ip, userAgent, success) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    userId,
    Date.now(),
    ip || null,
    userAgent || null,
    success ? 1 : 0
  );
}

// --- Query panel admin ----------------------------------------------------

function isAdminUser(user) {
  return Boolean(user && user.role === 'admin');
}

// Semua user dengan kolom aman + info turunan: MFA aktif, login sukses
// terakhir, jumlah ganti password. deletedAt dibawa apa adanya supaya UI bisa
// menandai "deleted" (phase 3) tanpa perubahan di sini.
function listUsers() {
  const rows = db
    .prepare(
      `SELECT ${SAFE_USER_COLUMNS},
         (SELECT MAX(occurredAt) FROM login_history
            WHERE userId = users.id AND success = 1) AS lastLoginAt,
         (SELECT COUNT(*) FROM password_change_log
            WHERE userId = users.id) AS passwordChangeCount
       FROM users
       ORDER BY createdAt ASC`
    )
    .all();
  return rows.map((r) => ({
    ...r,
    mfaEnabled: isMfaEnabled(r.id),
    deleted: Boolean(r.deletedAt)
  }));
}

// Profil aman satu user + riwayat lengkap untuk halaman detail.
function getUserDetail(userId) {
  const user = db
    .prepare(`SELECT ${SAFE_USER_COLUMNS} FROM users WHERE id = ?`)
    .get(userId);
  if (!user) return null;

  const emailHistory = db
    .prepare(
      `SELECT id, oldEmail, changedAt FROM email_history
       WHERE userId = ? ORDER BY changedAt DESC`
    )
    .all(userId);

  const passwordChanges = db
    .prepare(
      `SELECT id, changedVia, changedAt FROM password_change_log
       WHERE userId = ? ORDER BY changedAt DESC`
    )
    .all(userId);

  const loginHistory = db
    .prepare(
      `SELECT id, occurredAt, ip, userAgent, success FROM login_history
       WHERE userId = ? ORDER BY occurredAt DESC LIMIT 50`
    )
    .all(userId);

  return {
    ...user,
    deleted: Boolean(user.deletedAt),
    mfaEnabled: isMfaEnabled(userId),
    emailHistory,
    passwordChanges,
    loginHistory,
    connectedApps: listConnectedClients(userId)
  };
}

// Ubah role. Menolak (tanpa throw) bila demosi ini akan menyisakan 0 admin.
function setUserRole(userId, newRole) {
  if (newRole !== 'user' && newRole !== 'admin') {
    return { error: 'invalid_role' };
  }
  const user = db.prepare(`SELECT id, role FROM users WHERE id = ?`).get(userId);
  if (!user) {
    return { error: 'not_found' };
  }
  if (user.role === 'admin' && newRole === 'user') {
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
      .get();
    if (n <= 1) {
      return { error: 'last_admin' };
    }
  }
  db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(newRole, userId);
  return { ok: true, user: getUserDetail(userId) };
}

const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari masa pemulihan

// Batalkan soft-delete: kosongkan deletedAt. Tidak menyentuh data lain — akun
// kembali persis seperti sebelum dihapus. Menolak (tanpa throw) bila akun
// memang tidak sedang terhapus.
function restoreUserAccount(userId) {
  const user = db
    .prepare(`SELECT id, deletedAt FROM users WHERE id = ?`)
    .get(userId);
  if (!user) return { error: 'not_found' };
  if (!user.deletedAt) return { error: 'not_deleted' };
  db.prepare(`UPDATE users SET deletedAt = NULL WHERE id = ?`).run(userId);
  return { ok: true, user: getUserDetail(userId) };
}

// Reset cooldown ganti username: kosongkan usernameChangedAt (NULL) sehingga
// user boleh langsung ganti username lagi. Menolak (tanpa throw) bila user
// tidak ada.
function resetUsernameCooldown(userId) {
  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
  if (!user) return { error: 'not_found' };
  db.prepare(`UPDATE users SET usernameChangedAt = NULL WHERE id = ?`).run(userId);
  return { ok: true, user: getUserDetail(userId) };
}

// Akun soft-deleted yang MASIH dalam masa tenggang 7 hari (belum kena purge).
// Menyertakan daysRemaining terhitung supaya UI cukup menampilkan tanpa hitung
// ulang di klien.
function listDeletedAccounts() {
  const cutoff = Date.now() - GRACE_PERIOD_MS;
  const rows = db
    .prepare(
      `SELECT ${SAFE_USER_COLUMNS} FROM users
       WHERE deletedAt IS NOT NULL AND deletedAt >= ?
       ORDER BY deletedAt DESC`
    )
    .all(cutoff);
  return rows.map((r) => {
    const msRemaining = r.deletedAt + GRACE_PERIOD_MS - Date.now();
    return {
      ...r,
      deleted: true,
      daysRemaining: Math.max(0, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)))
    };
  });
}

// --- Rollback transaksi (pemulihan sesi/rentang terkompromi) ----------------

// Kelompokkan jejak audit per sessionLabel: satu baris per sesi dengan rentang
// waktu + hitungan add/delete. Untuk daftar "pilih sesi yang mau di-rollback".
function listTransactionSessions(userId) {
  return db
    .prepare(
      `SELECT sessionLabel,
              MIN(performedAt) AS firstAt,
              MAX(performedAt) AS lastAt,
              SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) AS addCount,
              SUM(CASE WHEN action = 'delete' THEN 1 ELSE 0 END) AS deleteCount
         FROM transaction_audit_log
        WHERE userId = ?
        GROUP BY sessionLabel
        ORDER BY lastAt DESC`
    )
    .all(userId);
}

// Validasi & normalisasi kriteria seleksi: TEPAT satu mode (sessionLabel ATAU
// rentang fromTime/toTime). Mengembalikan { rows } newest-first, atau { error }.
function selectAuditRows(userId, criteria) {
  const hasSession = criteria && criteria.sessionLabel != null && criteria.sessionLabel !== '';
  const hasRange =
    criteria &&
    criteria.fromTime != null && criteria.fromTime !== '' &&
    criteria.toTime != null && criteria.toTime !== '';

  if (hasSession === hasRange) {
    // Keduanya ada atau keduanya kosong — bukan tepat satu mode.
    return { error: 'invalid_criteria' };
  }

  let rows;
  if (hasSession) {
    rows = db
      .prepare(
        `SELECT * FROM transaction_audit_log
          WHERE userId = ? AND sessionLabel = ?
          ORDER BY performedAt DESC, rowid DESC`
      )
      .all(userId, String(criteria.sessionLabel));
  } else {
    const from = Number(criteria.fromTime);
    const to = Number(criteria.toTime);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return { error: 'invalid_criteria' };
    }
    rows = db
      .prepare(
        `SELECT * FROM transaction_audit_log
          WHERE userId = ? AND performedAt BETWEEN ? AND ?
          ORDER BY performedAt DESC, rowid DESC`
      )
      .all(userId, from, to);
  }
  return { rows };
}

// Apakah baris transaksi dengan id ini masih ada milik user (untuk 'add' rollback).
function transactionExists(userId, transactionId) {
  if (transactionId == null) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM transactions WHERE id = ? AND userId = ?`)
    .get(transactionId, userId);
  return Boolean(row);
}

// Ringkas apa yang AKAN terjadi tanpa mengeksekusi apa pun.
// toRestore: snapshot entri 'delete'. toRemove: entri 'add' yang barisnya MASIH ada.
function previewRollback(userId, criteria) {
  const sel = selectAuditRows(userId, criteria);
  if (sel.error) return { error: sel.error };

  const toRestore = [];
  const toRemove = [];
  for (const r of sel.rows) {
    let snapshot;
    try {
      snapshot = JSON.parse(r.snapshot);
    } catch {
      snapshot = null;
    }
    if (r.action === 'delete') {
      toRestore.push(snapshot);
    } else if (r.action === 'add') {
      if (transactionExists(userId, r.transactionId)) {
        toRemove.push({ transactionId: r.transactionId, snapshot });
      }
    }
  }
  return { toRestore, toRemove };
}

// Eksekusi rollback: hapus baris 'add' yang masih ada, sisipkan ulang baris
// 'delete' dari snapshot. TIDAK menulis jejak audit baru (koreksi administratif,
// bukan aksi user). Mengembalikan jumlah aktual { restored, removed }.
function rollbackTransactions(userId, criteria) {
  const sel = selectAuditRows(userId, criteria);
  if (sel.error) return { error: sel.error };

  const delStmt = db.prepare(`DELETE FROM transactions WHERE id = ? AND userId = ?`);
  const insStmt = db.prepare(
    `INSERT INTO transactions (userId, jenis, keterangan, jumlah, waktu) VALUES (?, ?, ?, ?, ?)`
  );

  let restored = 0;
  let removed = 0;
  for (const r of sel.rows) {
    if (r.action === 'add') {
      const info = delStmt.run(r.transactionId, userId);
      if (info.changes > 0) removed += Number(info.changes);
    } else if (r.action === 'delete') {
      let snap;
      try {
        snap = JSON.parse(r.snapshot);
      } catch {
        snap = null;
      }
      if (snap) {
        insStmt.run(userId, snap.jenis, snap.keterangan, snap.jumlah, snap.waktu);
        restored += 1;
      }
    }
  }
  return { restored, removed };
}

function logAdminAction({ adminUserId, action, targetUserId, detail }) {
  db.prepare(
    `INSERT INTO admin_actions (id, adminUserId, action, targetUserId, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    adminUserId,
    action,
    targetUserId || null,
    detail || null,
    Date.now()
  );
}

export {
  recordEmailHistory,
  recordPasswordChange,
  recordLoginHistory,
  isAdminUser,
  listUsers,
  getUserDetail,
  setUserRole,
  restoreUserAccount,
  resetUsernameCooldown,
  listDeletedAccounts,
  listTransactionSessions,
  previewRollback,
  rollbackTransactions,
  logAdminAction
};
