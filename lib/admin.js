import crypto from 'crypto';
import db from './db.js';
import { isMfaEnabled } from './mfa.js';
import { listConnectedClients } from './oauth-store.js';
import { accounts } from './accounts-client.js';

// --- Perekam riwayat lokal (login_history & admin_actions tetap milik UangKu) ---

// Dipanggil dari handlers.js setiap kesimpulan percobaan login (sukses & gagal).
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

function getLocalUser(userId) {
  return db.prepare(`SELECT * FROM users_local WHERE id = ?`).get(userId)
    || { id: userId, role: 'user', subscription: 'free' };
}
function ensureLocalUser(userId) {
  db.prepare(`INSERT OR IGNORE INTO users_local (id, role, subscription) VALUES (?, 'user', 'free')`).run(userId);
}

function lastLoginAt(userId) {
  const row = db.prepare(
    `SELECT MAX(occurredAt) AS t FROM login_history WHERE userId = ? AND success = 1`
  ).get(userId);
  return row ? row.t : null;
}

// --- Query panel admin (identitas dari accounts service, role/subscription lokal) ---

function isAdminUser(user) {
  return Boolean(user && user.role === 'admin');
}

// Semua user: identitas dari accounts service + role/subscription/mfaEnabled/
// lastLoginAt lokal. deletedAt dibawa apa adanya supaya UI bisa menandai "deleted".
async function listUsers() {
  const resp = await accounts.get('/internal/users?limit=1000');
  if (resp.status !== 200) return [];
  return resp.body.items.map((u) => {
    const local = getLocalUser(u.id);
    return {
      ...u,
      role: local.role,
      subscription: local.subscription,
      lastLoginAt: lastLoginAt(u.id),
      passwordChangeCount: u.passwordChangeCount,
      mfaEnabled: isMfaEnabled(u.id),
      deleted: Boolean(u.deletedAt)
    };
  });
}

// Profil aman satu user + riwayat lengkap untuk halaman detail.
async function getUserDetail(userId) {
  const resp = await accounts.get(`/internal/users/${userId}`);
  if (resp.status !== 200) return null;
  const user = resp.body;
  const local = getLocalUser(userId);

  const historyResp = await accounts.get(`/internal/users/${userId}/history`);
  const emailHistory = historyResp.status === 200 ? historyResp.body.emailHistory : [];
  const passwordChanges = historyResp.status === 200 ? historyResp.body.passwordChanges : [];

  const loginHistory = db
    .prepare(
      `SELECT id, occurredAt, ip, userAgent, success FROM login_history
       WHERE userId = ? ORDER BY occurredAt DESC LIMIT 50`
    )
    .all(userId);

  return {
    ...user,
    role: local.role,
    subscription: local.subscription,
    deleted: Boolean(user.deletedAt),
    mfaEnabled: isMfaEnabled(userId),
    emailHistory,
    passwordChanges,
    loginHistory,
    connectedApps: listConnectedClients(userId)
  };
}

// Ubah role. Menolak (tanpa throw) bila demosi ini akan menyisakan 0 admin.
// role sepenuhnya data lokal (users_local) — cuma perlu pastikan identitasnya
// benar-benar ada di accounts service dulu.
async function setUserRole(userId, newRole) {
  if (newRole !== 'user' && newRole !== 'admin') {
    return { error: 'invalid_role' };
  }
  const exists = await accounts.get(`/internal/users/${userId}`);
  if (exists.status !== 200) {
    return { error: 'not_found' };
  }
  const current = getLocalUser(userId);
  if (current.role === 'admin' && newRole === 'user') {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM users_local WHERE role = 'admin'`).get();
    if (n <= 1) {
      return { error: 'last_admin' };
    }
  }
  ensureLocalUser(userId);
  db.prepare(`UPDATE users_local SET role = ? WHERE id = ?`).run(newRole, userId);
  return { ok: true, user: await getUserDetail(userId) };
}

// Batalkan soft-delete (deletedAt hidup di accounts service).
async function restoreUserAccount(userId) {
  const r = await accounts.post(`/internal/users/${userId}/restore`, {});
  if (r.status !== 200) return { error: r.body.error || 'not_found' };
  return { ok: true, user: await getUserDetail(userId) };
}

// Reset cooldown ganti username (usernameChangedAt hidup di accounts service).
async function resetUsernameCooldown(userId) {
  const r = await accounts.post(`/internal/users/${userId}/reset-username-cooldown`, {});
  if (r.status !== 200) return { error: r.body.error || 'not_found' };
  return { ok: true, user: await getUserDetail(userId) };
}

// Akun soft-deleted yang MASIH dalam masa tenggang 7 hari (belum kena purge).
async function listDeletedAccounts() {
  const resp = await accounts.get('/internal/users/deleted');
  if (resp.status !== 200) return [];
  return resp.body.items.map((u) => {
    const local = getLocalUser(u.id);
    return { ...u, role: local.role, subscription: local.subscription, deleted: true };
  });
}

// --- Rollback transaksi (pemulihan sesi/rentang terkompromi) — sepenuhnya data lokal ---

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

function selectAuditRows(userId, criteria) {
  const hasSession = criteria && criteria.sessionLabel != null && criteria.sessionLabel !== '';
  const hasRange =
    criteria &&
    criteria.fromTime != null && criteria.fromTime !== '' &&
    criteria.toTime != null && criteria.toTime !== '';

  if (hasSession === hasRange) {
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

function transactionExists(userId, transactionId) {
  if (transactionId == null) return false;
  const row = db
    .prepare(`SELECT 1 AS ok FROM transactions WHERE id = ? AND userId = ?`)
    .get(transactionId, userId);
  return Boolean(row);
}

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

// Dipanggil oleh POST /internal/hooks/user-purged (dari accounts service) saat
// akun benar-benar dipurge permanen — bersihkan data lokal UangKu yang dulu
// jadi bagian dari purgeUserAccount satu-proses.
function purgeLocalUserData(userId) {
  db.prepare('DELETE FROM transactions WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM telegram_links WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM api_tokens WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM mfa_totp WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM mfa_backup_codes WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM mfa_login_challenges WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM login_history WHERE userId = ?').run(userId);
  db.prepare('DELETE FROM admin_actions WHERE targetUserId = ?').run(userId);
  db.prepare('DELETE FROM users_local WHERE id = ?').run(userId);
}

export {
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
  logAdminAction,
  purgeLocalUserData
};
