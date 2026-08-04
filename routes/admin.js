const express = require('express');
const bcrypt = require('bcryptjs');
const { db, generateAccountNumber, generateCardNumber, generateCVV } = require('../database');
const { syncLocalUserToFirebaseAuth } = require('../lib/firebase-admin');
const {
  sendPasswordChangedEmail,
  sendTransactionActivityEmailById
} = require('../services/email');
const {
  requireAdmin,
  addNotification,
  addAuditLog,
  generateAccountNumber: generateAcc
} = require('../middleware/auth');
const {
  getFirestoreDashboardCustomerStats,
  hydrateRecentCustomersFromFirestore,
  hydrateUserFromFirestoreById,
  isFirestoreEnabled,
  syncUserBundleToFirestore,
  syncAccountToFirestore,
  syncTransactionToFirestore
} = require('../services/firestore-sync');

const router = express.Router();

const OUTGOING_TYPES = new Set(['local_transfer', 'international_transfer', 'withdrawal', 'bill_payment', 'loan_payment']);
const INCOMING_TYPES = new Set(['deposit', 'loan_disbursement']);
const ACCOUNT_STATUS_OPTIONS = new Set(['active', 'frozen', 'blocked', 'closed']);
const NON_OPERABLE_ACCOUNT_STATUSES = new Set(['frozen', 'blocked', 'closed']);

function parseMoney(value, fallback = 0) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSqlDateTime(value) {
  if (!value) {
    return new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  const normalized = String(value).trim().replace('T', ' ');
  return normalized.length === 16 ? `${normalized}:00` : normalized;
}

// Treat a record as a customer if it is explicitly non-admin or it owns a non-admin account.
// This keeps dashboard counts accurate when imported or migrated rows have inconsistent flags.
function buildCustomerScope(extraConditions = '') {
  return `
    FROM users u
    WHERE (
      COALESCE(u.is_admin, 0) = 0
      OR EXISTS (
        SELECT 1
        FROM accounts a
        WHERE a.user_id = u.id
          AND COALESCE(a.account_type, '') != 'Admin Account'
      )
    )
    ${extraConditions}
  `;
}

async function hydrateAdminCustomerDirectory() {
  if (!isFirestoreEnabled()) {
    return;
  }

  try {
    await hydrateRecentCustomersFromFirestore(200);
  } catch (error) {
    console.error('Failed to hydrate admin customer directory from Firestore:', error);
  }
}

async function findAdminCustomerById(userId) {
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user) {
    return user;
  }

  if (!isFirestoreEnabled()) {
    return null;
  }

  try {
    user = await hydrateUserFromFirestoreById(userId);
  } catch (error) {
    console.error('Failed to hydrate admin user from Firestore:', error);
  }

  return user || null;
}

function getTransactionImpact(txn) {
  if (!txn) {
    return { balance: 0, available: 0 };
  }

  const amount = Math.abs(parseMoney(txn.amount));
  const fee = Math.abs(parseMoney(txn.fee));

  if (txn.transaction_type === 'admin_adjustment') {
    const signed = parseMoney(txn.amount);
    if (txn.status === 'completed') {
      return { balance: signed, available: signed };
    }
    return { balance: 0, available: 0 };
  }

  if (txn.status === 'pending') {
    if (OUTGOING_TYPES.has(txn.transaction_type)) {
      return { balance: 0, available: -(amount + fee) };
    }
    return { balance: 0, available: 0 };
  }

  if (txn.status !== 'completed') {
    return { balance: 0, available: 0 };
  }

  if (OUTGOING_TYPES.has(txn.transaction_type)) {
    return { balance: -(amount + fee), available: -(amount + fee) };
  }

  if (INCOMING_TYPES.has(txn.transaction_type)) {
    return { balance: amount, available: amount };
  }

  return { balance: 0, available: 0 };
}

async function syncAccountAndTxnToFirestore(accountId, txnId) {
  if (!isFirestoreEnabled()) return true;
  try {
    const promises = [];
    if (accountId) {
      const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
      if (acc) promises.push(syncAccountToFirestore(acc));
    }
    if (txnId) {
      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
      if (txn) promises.push(syncTransactionToFirestore(txn));
    }
    await Promise.all(promises);
    return true;
  } catch (err) {
    console.error('syncAccountAndTxnToFirestore failed:', err);
    return false;
  }
}

async function syncUserBundle(userId) {
  if (!isFirestoreEnabled()) return true;
  try {
    await syncUserBundleToFirestore(userId);
    return true;
  } catch (err) {
    console.error(`syncUserBundle failed for user ${userId}:`, err);
    return false;
  }
}

function queueTransactionEmail(txnId, note) {
  if (!txnId) return;
  sendTransactionActivityEmailById(txnId, note ? { note } : {}).catch((error) => {
    console.error(`Failed to send transaction email for txn ${txnId}:`, error);
  });
}

function applyAccountImpact(accountId, impact, multiplier = 1) {
  if (!accountId || (!impact.balance && !impact.available)) {
    return;
  }

  db.prepare(`
    UPDATE accounts
    SET balance = balance + ?, available_balance = available_balance + ?
    WHERE id = ?
  `).run(impact.balance * multiplier, impact.available * multiplier, accountId);
}

function getAccountRestrictionMessage(account, action = 'complete this action') {
  if (!account) {
    return 'Account not found.';
  }

  const status = String(account.status || 'active').toLowerCase();
  if (!NON_OPERABLE_ACCOUNT_STATUSES.has(status)) {
    return null;
  }

  if (status === 'frozen') {
    return `This account is frozen and cannot be used to ${action}.`;
  }

  if (status === 'blocked') {
    return `This account is blocked and cannot be used to ${action}.`;
  }

  return `This account is closed and cannot be used to ${action}.`;
}

function resolveAccountRestrictions(accountId, adminId, reason) {
  const pendingTransactions = db.prepare(`
    SELECT * FROM transactions
    WHERE account_id = ? AND status = 'pending' AND transaction_type IN ('local_transfer', 'international_transfer', 'withdrawal', 'bill_payment', 'loan_payment')
  `).all(accountId);
  const pendingBills = db.prepare(`
    SELECT * FROM bill_payments
    WHERE account_id = ? AND status IN ('pending', 'scheduled')
  `).all(accountId);

  const tx = db.transaction(() => {
    pendingTransactions.forEach((txn) => {
      const refund = parseMoney(txn.amount) + parseMoney(txn.fee);
      if (refund > 0) {
        db.prepare('UPDATE accounts SET available_balance = available_balance + ? WHERE id = ?').run(refund, accountId);
      }

      db.prepare(`
        UPDATE transactions
        SET status = 'rejected', rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reason, adminId, txn.id);
    });

    pendingBills.forEach((bill) => {
      db.prepare(`
        UPDATE bill_payments
        SET status = 'rejected', rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(reason, adminId, bill.id);
    });
  });
  tx();

  return {
    transactionsRejected: pendingTransactions.length,
    billsRejected: pendingBills.length
  };
}

function buildTransactionPayload(body) {
  return {
    account_id: parseInt(body.account_id, 10),
    transaction_type: body.transaction_type,
    amount: parseMoney(body.amount),
    currency: body.currency || 'AUD',
    description: body.description || '',
    reference: body.reference || '',
    recipient_name: body.recipient_name || '',
    recipient_account: body.recipient_account || '',
    recipient_bsb: body.recipient_bsb || '',
    recipient_bank: body.recipient_bank || '',
    swift_code: body.swift_code || '',
    iban: body.iban || '',
    country: body.country || 'Australia',
    status: body.status || 'completed',
    fee: parseMoney(body.fee),
    exchange_rate: body.exchange_rate ? parseMoney(body.exchange_rate) : null,
    converted_amount: body.converted_amount ? parseMoney(body.converted_amount) : null,
    created_at: toSqlDateTime(body.created_at),
    approved_by: body.status === 'pending' ? null : body.approved_by || null,
    approved_at: body.status === 'pending' ? null : toSqlDateTime(body.approved_at || body.created_at)
  };
}

async function getStats() {
  if (isFirestoreEnabled()) {
    try {
      await hydrateRecentCustomersFromFirestore(200);
    } catch (err) {
      console.error('Failed to pre-hydrate customers for stats:', err);
    }
  }

  const todayTransactions = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as volume
    FROM transactions
    WHERE DATE(created_at) = DATE('now')
  `).get();
  const newThisWeek = db.prepare(`
    SELECT COUNT(*) as count
    ${buildCustomerScope("AND DATE(u.created_at) >= DATE('now', '-7 days')")}
  `).get().count;
  const activeCards = db.prepare(`
    SELECT COUNT(*) as count
    FROM cards
    WHERE status IN ('approved', 'active')
  `).get().count;
  const activeLoans = db.prepare(`
    SELECT COUNT(*) as count
    FROM loans
    WHERE status = 'disbursed'
  `).get().count;
  const unverifiedCustomers = db.prepare(`
    SELECT COUNT(*) as count
    ${buildCustomerScope('AND COALESCE(u.is_verified, 0) = 0')}
  `).get().count;
  const totalLoansOutstanding = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(remaining_balance, loan_amount)), 0) as total
    FROM loans
    WHERE status = 'disbursed'
  `).get().total;

  const totalUsers = db.prepare(`
    SELECT COUNT(*) as count
    ${buildCustomerScope()}
  `).get().count;
  const totalAccounts = db.prepare('SELECT COUNT(*) as count FROM accounts').get().count;
  const totalCards = db.prepare('SELECT COUNT(*) as count FROM cards').get().count;
  const totalLoans = db.prepare('SELECT COUNT(*) as count FROM loans').get().count;
  const pendingKYC = db.prepare("SELECT COUNT(*) as count FROM kyc WHERE status = 'pending'").get().count;
  const pendingTransfers = db.prepare("SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'").get().count;
  const pendingCards = db.prepare("SELECT COUNT(*) as count FROM cards WHERE status = 'pending'").get().count;
  const pendingLoans = db.prepare("SELECT COUNT(*) as count FROM loans WHERE status = 'pending'").get().count;
  const pendingBills = db.prepare("SELECT COUNT(*) as count FROM bill_payments WHERE status = 'pending'").get().count;
  const frozenAccounts = db.prepare("SELECT COUNT(*) as count FROM users WHERE is_frozen = 1").get().count;
  const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) as total FROM accounts').get().total;
  const loansDisbursed = db.prepare("SELECT COALESCE(SUM(loan_amount), 0) as total FROM loans WHERE status = 'disbursed'").get().total;
  const recentUsers = db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) as account_count
      ${buildCustomerScope()}
      ORDER BY u.created_at DESC
      LIMIT 5
    `).all();
  const recentTransactions = db.prepare(`
      SELECT t.*, u.first_name, u.last_name, a.account_name
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      JOIN accounts a ON t.account_id = a.id
      ORDER BY t.created_at DESC
      LIMIT 10
    `).all();

  const baseStats = {
    totalUsers,
    totalCustomers: totalUsers,
    totalAccounts,
    totalCards,
    totalLoans,
    pendingKYC,
    pendingTransfers,
    pendingCards,
    pendingLoans,
    pendingBills,
    frozenAccounts,
    totalBalance,
    totalDeposits: totalBalance,
    loansDisbursed,
    totalLoansOutstanding,
    recentUsers,
    recentTransactions,
    todayTransactions: todayTransactions.count,
    todayVolume: todayTransactions.volume,
    newThisWeek,
    activeCards,
    activeLoans,
    unverifiedCustomers
  };

  if (!isFirestoreEnabled()) {
    return baseStats;
  }

  try {
    const firestoreStats = await getFirestoreDashboardCustomerStats();
    if (!firestoreStats) {
      return baseStats;
    }

    return {
      ...baseStats,
      totalUsers: Math.max(baseStats.totalUsers, firestoreStats.totalCustomers),
      totalCustomers: Math.max(baseStats.totalCustomers, firestoreStats.totalCustomers),
      newThisWeek: Math.max(baseStats.newThisWeek, firestoreStats.newThisWeek),
      unverifiedCustomers: Math.max(baseStats.unverifiedCustomers, firestoreStats.unverifiedCustomers),
      recentUsers: firestoreStats.recentUsers.length > baseStats.recentUsers.length ? firestoreStats.recentUsers : baseStats.recentUsers
    };
  } catch (error) {
    console.error('Failed to load customer stats from Firestore:', error);
    return baseStats;
  }
}

router.get('/dashboard', requireAdmin, async (req, res) => {
  const stats = await getStats();
  const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  res.render('admin/dashboard', {
    title: 'Admin Dashboard - United Credit Bank',
    page: 'admin-dashboard',
    admin,
    user: admin,
    stats,
    pendingCount: stats.pendingKYC + stats.pendingTransfers + stats.pendingCards + stats.pendingLoans + stats.pendingBills,
    recentUsers: stats.recentUsers,
    recentTransactions: stats.recentTransactions
  });
});

router.get('/users', requireAdmin, async (req, res) => {
  const { search, status, verified } = req.query;
  await hydrateAdminCustomerDirectory();

  let query = `SELECT u.* ${buildCustomerScope()}`;
  const params = [];

  if (search) {
    query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)';
    const searchTerm = `%${search}%`;
    params.push(searchTerm, searchTerm, searchTerm, searchTerm);
  }
  if (status === 'frozen') query += ' AND COALESCE(u.is_frozen, 0) = 1';
  if (status === 'active') query += ' AND COALESCE(u.is_frozen, 0) = 0';
  if (verified === 'verified') query += ' AND COALESCE(u.is_verified, 0) = 1';
  if (verified === 'unverified') query += ' AND COALESCE(u.is_verified, 0) = 0';

  query += ' ORDER BY u.created_at DESC LIMIT 200';
  const users = db.prepare(query).all(...params);

  users.forEach(u => {
    u.accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(u.id);
  });

  const userAccounts = Object.fromEntries(users.map(u => [u.id, u.accounts]));

  res.render('admin/users', {
    title: 'User Management - United Credit Bank',
    page: 'admin-users',
    users,
    userAccounts,
    filters: req.query
  });
});

router.get('/users/create', requireAdmin, (req, res) => {
  res.render('admin/user-create', {
    title: 'Create User - United Credit Bank',
    page: 'admin-users'
  });
});

router.post('/users/create', requireAdmin, async (req, res) => {
  const { first_name, last_name, email, phone, password, address, city, state, postcode, date_of_birth, initial_balance, account_type, is_verified } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    req.session.error = 'Email already exists.';
    return res.redirect('/admin/users/create');
  }

  const hashedPassword = await bcrypt.hash(password || 'TempPass2026!', 10);
  const tx = db.transaction(() => {
    const insertUser = db.prepare(`
      INSERT INTO users (
        first_name, last_name, email, phone, password, address, city, state, postcode, date_of_birth,
        is_admin, is_verified, is_frozen, role
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, 'customer')
    `);
    const result = insertUser.run(first_name, last_name, normalizedEmail, phone, hashedPassword, address || '', city || '', state || '', postcode || '', date_of_birth || null, is_verified ? 1 : 0);

    const accNum = generateAccountNumber();
    db.prepare(`
      INSERT INTO accounts (user_id, account_number, account_type, account_name, balance, available_balance, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(result.lastInsertRowid, accNum, account_type || 'Everyday Savings', `${first_name} ${last_name}`, initial_balance || 0, initial_balance || 0);

    return result.lastInsertRowid;
  });

  const userId = tx();
  if (isFirestoreEnabled()) {
    try {
      await syncUserBundleToFirestore(userId);
    } catch (error) {
      console.error('Failed to sync admin-created user to Firestore:', error);
      req.session.error = 'User was created locally, but Firestore sync failed. Please try again.';
      return res.redirect(`/admin/users/${userId}`);
    }
  }
  addAuditLog(req.session.userId, 'CREATE_USER', 'user', userId, `Created user: ${first_name} ${last_name} (${normalizedEmail})`, req.ip);
  addNotification(userId, 'Account Created', 'Your United Credit Bank account has been created by an administrator.', 'success');

  req.session.success = `User ${first_name} ${last_name} created successfully.`;
  res.redirect(`/admin/users/${userId}`);
});

router.get('/users/:id', requireAdmin, async (req, res) => {
  const user = await findAdminCustomerById(req.params.id);
  if (!user) {
    req.session.error = 'User not found.';
    return res.redirect('/admin/users');
  }

  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(user.id);
  const transactions = db.prepare(`
    SELECT t.*, a.account_name
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
    LIMIT 50
  `).all(user.id);
  const cards = db.prepare('SELECT * FROM cards WHERE user_id = ?').all(user.id);
  const loans = db.prepare('SELECT * FROM loans WHERE user_id = ?').all(user.id);
  const kycRecords = db.prepare('SELECT * FROM kyc WHERE user_id = ? ORDER BY id DESC').all(user.id);
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id);
  const logs = db.prepare(`
    SELECT al.*, u.first_name as admin_first, u.last_name as admin_last
    FROM audit_logs al
    JOIN users u ON al.admin_id = u.id
    WHERE al.target_id = ? AND al.target_type = 'user'
    ORDER BY al.created_at DESC
    LIMIT 20
  `).all(user.id);

  res.render('admin/user-detail', {
    title: `User: ${user.first_name} ${user.last_name} - United Credit Bank`,
    page: 'admin-users',
    user,
    customer: user,
    accounts,
    transactions,
    cards,
    loans,
    kyc: kycRecords,
    latestKyc: kycRecords[0] || null,
    notifications,
    logs,
    auditLogs: logs,
    totalBalance: accounts.reduce((s, a) => s + parseFloat(a.balance), 0)
  });
});

router.post('/users/:id/update', requireAdmin, async (req, res) => {
  const { first_name, last_name, email, phone, address, city, state, postcode, country, date_of_birth, is_verified, is_frozen } = req.body;
  const userId = req.params.id;

  const existingUser = await findAdminCustomerById(userId);
  if (!existingUser) {
    req.session.error = 'User not found.';
    return res.redirect('/admin/users');
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
  if (existingEmail) {
    req.session.error = 'Email already in use.';
    return res.redirect(`/admin/users/${userId}`);
  }

  db.prepare(`
    UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, postcode = ?, country = ?, date_of_birth = ?, is_verified = ?, is_frozen = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(first_name, last_name, email, phone, address, city, state, postcode, country || 'Australia', date_of_birth || null, is_verified ? 1 : 0, is_frozen ? 1 : 0, userId);

  if (isFirestoreEnabled()) {
    try {
      await syncUserBundleToFirestore(userId);
    } catch (error) {
      console.error('Failed to sync updated user to Firestore:', error);
      req.session.error = 'User was updated locally, but Firestore sync failed. Please try again.';
      return res.redirect(`/admin/users/${userId}`);
    }
  }

  addAuditLog(req.session.userId, 'UPDATE_USER', 'user', userId, `Updated details for ${first_name} ${last_name}`, req.ip);
  addNotification(userId, 'Account Updated', 'Your account details have been updated by an administrator.', 'info');

  if (is_frozen) {
    addNotification(userId, 'Account Frozen', 'Your account has been frozen. Please contact support.', 'warning');
  }

  req.session.success = 'User details updated successfully.';
  res.redirect(`/admin/users/${userId}`);
});

router.post('/users/:id/freeze', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const user = await findAdminCustomerById(userId);
  if (!user) {
    return res.json({ success: false, message: 'User not found' });
  }

  const newStatus = user.is_frozen === 1 ? 0 : 1;
  db.prepare('UPDATE users SET is_frozen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, userId);

  if (isFirestoreEnabled()) {
    try {
      await syncUserBundleToFirestore(userId);
    } catch (error) {
      console.error('Failed to sync user freeze state to Firestore:', error);
      return res.json({ success: false, message: 'User updated locally, but Firestore sync failed.' });
    }
  }

  addAuditLog(req.session.userId, newStatus ? 'FREEZE_USER' : 'UNFREEZE_USER', 'user', userId, `${newStatus ? 'Frozen' : 'Unfrozen'} account for ${user.first_name} ${user.last_name}`, req.ip);
  addNotification(userId, newStatus ? 'Account Frozen' : 'Account Unfrozen', newStatus ? 'Your account has been frozen.' : 'Your account has been unfrozen.', newStatus ? 'warning' : 'success');

  res.json({ success: true, frozen: newStatus === 1 });
});

router.get('/users/:id/freeze', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const user = await findAdminCustomerById(userId);
  if (!user) {
    req.session.error = 'User not found.';
    return res.redirect('/admin/users');
  }

  const newStatus = user.is_frozen === 1 ? 0 : 1;
  db.prepare('UPDATE users SET is_frozen = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, userId);

  if (isFirestoreEnabled()) {
    try {
      await syncUserBundleToFirestore(userId);
    } catch (error) {
      console.error('Failed to sync user freeze state to Firestore:', error);
      req.session.error = 'User was updated locally, but Firestore sync failed.';
      return res.redirect(req.get('referer') || `/admin/users/${userId}`);
    }
  }
  addAuditLog(req.session.userId, newStatus ? 'FREEZE_USER' : 'UNFREEZE_USER', 'user', userId, `${newStatus ? 'Frozen' : 'Unfrozen'} account for ${user.first_name} ${user.last_name}`, req.ip);
  addNotification(userId, newStatus ? 'Account Frozen' : 'Account Unfrozen', newStatus ? 'Your account has been frozen.' : 'Your account has been unfrozen.', newStatus ? 'warning' : 'success');

  req.session.success = `User ${newStatus ? 'frozen' : 'unfrozen'} successfully.`;
  res.redirect(req.get('referer') || `/admin/users/${userId}`);
});

router.post('/users/:id/reset-password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  const userId = req.params.id;

  const existingUser = await findAdminCustomerById(userId);
  if (!existingUser) {
    req.session.error = 'User not found.';
    return res.redirect('/admin/users');
  }

  if (!password || password.length < 8) {
    req.session.error = 'Password must be at least 8 characters.';
    return res.redirect(`/admin/users/${userId}`);
  }

  const hashed = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashed, userId);

  if (isFirestoreEnabled()) {
    try {
      await syncUserBundleToFirestore(userId);
    } catch (error) {
      console.error('Failed to sync password reset to Firestore:', error);
      req.session.error = 'Password was updated locally, but Firestore sync failed.';
      return res.redirect(`/admin/users/${userId}`);
    }
  }
  syncLocalUserToFirebaseAuth(
    db.prepare('SELECT * FROM users WHERE id = ?').get(userId),
    password
  ).catch((error) => {
    console.error('Failed to sync password reset to Firebase Authentication:', error);
  });
  sendPasswordChangedEmail(existingUser).catch((error) => {
    console.error('Failed to send admin reset password email:', error);
  });
  addAuditLog(req.session.userId, 'RESET_PASSWORD', 'user', userId, `Reset password for user ID ${userId}`, req.ip);
  addNotification(userId, 'Password Reset', 'Your password has been reset by an administrator.', 'info');

  req.session.success = 'Password reset successfully.';
  res.redirect(`/admin/users/${userId}`);
});

router.post('/users/:id/delete', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  if (userId == req.session.userId) {
    req.session.error = 'Cannot delete your own account.';
    return res.redirect(`/admin/users/${userId}`);
  }

  const user = await findAdminCustomerById(userId);
  if (!user) {
    req.session.error = 'User not found.';
    return res.redirect('/admin/users');
  }

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  addAuditLog(req.session.userId, 'DELETE_USER', 'user', userId, `Deleted user: ${user.first_name} ${user.last_name} (${user.email})`, req.ip);

  req.session.success = 'User deleted successfully.';
  res.redirect('/admin/users');
});

router.post('/users/:id/accounts/create', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { account_type, initial_balance, branch, bsb } = req.body;
  const user = await findAdminCustomerById(userId);
  if (!user) {
    req.session.error = 'User not found.';
    return res.redirect('/admin/users');
  }

  const accNum = generateAcc();
  const initBalance = parseFloat(initial_balance) || 0;

  const accountId = db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, account_name, balance, available_balance, status, branch, bsb)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).run(userId, accNum, account_type || 'Everyday Savings', `${user.first_name} ${user.last_name}`, initBalance, initBalance, branch || 'Sydney CBD', bsb || '082-987').lastInsertRowid;

  let txnId = null;
  if (initBalance > 0) {
    const txnInfo = db.prepare(`
      INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, status, approved_by, approved_at)
      VALUES (?, ?, 'deposit', ?, 'AUD', ?, 'completed', ?, CURRENT_TIMESTAMP)
    `).run(accountId, userId, initBalance, `Initial Deposit - Account Opening`, req.session.userId);
    txnId = txnInfo.lastInsertRowid;
  }

  if (isFirestoreEnabled()) {
    try {
      const newAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
      await syncAccountToFirestore(newAccount);
      if (txnId) {
        const initTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
        await syncTransactionToFirestore(initTxn);
      }
    } catch (error) {
      console.error('Failed to sync admin-created account to Firestore:', error);
      req.session.error = 'Account created locally, but Firestore sync failed.';
    }
  }

  addAuditLog(req.session.userId, 'CREATE_ACCOUNT', 'account', accountId, `Created ${account_type} account for user ${userId} with balance $${initBalance}`, req.ip);
  addNotification(userId, 'New Account Opened', `Your ${account_type || 'Everyday Savings'} account has been opened${initBalance > 0 ? ` with an initial balance of $${initBalance.toLocaleString()}` : ''}.`, 'success');
  if (txnId) {
    queueTransactionEmail(txnId, 'Your new account opening deposit has been recorded.');
  }

  if (!req.session.error) {
    req.session.success = 'Account created successfully.';
  }
  res.redirect(`/admin/users/${userId}`);
});

router.post('/users/:id/account', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/users/${req.params.id}/accounts/create`);
});

router.post('/users/:id/adjust-balance', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const { account_id, adjustment_type, amount, reason } = req.body;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(account_id, userId);
  if (!account) {
    req.session.error = 'Account not found.';
    return res.redirect(`/admin/users/${userId}`);
  }

  const amt = parseFloat(amount);
  let newBalance, newAvailable;
  if (adjustment_type === 'credit') {
    newBalance = parseFloat(account.balance) + amt;
    newAvailable = parseFloat(account.available_balance) + amt;
  } else {
    newBalance = parseFloat(account.balance) - amt;
    newAvailable = parseFloat(account.available_balance) - amt;
  }

  const txnAmount = adjustment_type === 'credit' ? amt : -amt;
  const txnDescription = `Admin Adjustment: ${reason || adjustment_type} by Admin #${req.session.userId}`;

  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance = ?, available_balance = ? WHERE id = ?').run(newBalance, newAvailable, account_id);
    const info = db.prepare(`
      INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, status, approved_by, approved_at)
      VALUES (?, ?, 'admin_adjustment', ?, 'AUD', ?, 'completed', ?, CURRENT_TIMESTAMP)
    `).run(account_id, userId, txnAmount, txnDescription, req.session.userId);
    return info.lastInsertRowid;
  });

  const transactionId = tx();

  if (isFirestoreEnabled()) {
    try {
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id);
      const newTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
      await Promise.all([
        syncAccountToFirestore(updatedAccount),
        syncTransactionToFirestore(newTxn)
      ]);
    } catch (error) {
      console.error('Failed to sync balance adjustment to Firestore:', error);
      req.session.error = 'Balance adjusted locally, but Firestore sync failed.';
    }
  }

  addAuditLog(req.session.userId, 'BALANCE_ADJUSTMENT', 'account', account_id, `${adjustment_type === 'credit' ? 'Credited' : 'Debited'} $${amt} to account ${account.account_number}: ${reason}`, req.ip);
  addNotification(userId, 'Account Adjustment', `Your account has been ${adjustment_type === 'credit' ? 'credited' : 'debited'} $${amt.toLocaleString()}.`, adjustment_type === 'credit' ? 'success' : 'warning');
  queueTransactionEmail(transactionId, `An administrator ${adjustment_type === 'credit' ? 'credited' : 'debited'} your account.`);

  if (!req.session.error) {
    req.session.success = `Balance adjusted: $${amt.toLocaleString()} ${adjustment_type === 'credit' ? 'credited' : 'debited'}.`;
  }
  res.redirect(`/admin/users/${userId}`);
});

router.get('/approvals', requireAdmin, (req, res) => {
  const section = req.query.section || 'all';

  const data = {
    kyc: section === 'all' || section === 'kyc' ? db.prepare(`
      SELECT k.*, u.first_name, u.last_name, u.email, u.phone
      FROM kyc k
      JOIN users u ON k.user_id = u.id
      WHERE k.status = 'pending'
      ORDER BY k.submitted_at
    `).all() : [],
    transfers: section === 'all' || section === 'transfers' ? db.prepare(`
      SELECT t.*, u.first_name, u.last_name, u.email, a.account_name, a.account_number,
        (u.first_name || ' ' || u.last_name) as user_name
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      JOIN accounts a ON t.account_id = a.id
      WHERE t.status = 'pending'
      ORDER BY t.created_at
    `).all() : [],
    cards: section === 'all' || section === 'cards' ? db.prepare(`
      SELECT c.*, u.first_name, u.last_name, u.email, a.account_name,
        (u.first_name || ' ' || u.last_name) as user_name
      FROM cards c
      JOIN users u ON c.user_id = u.id
      JOIN accounts a ON c.account_id = a.id
      WHERE c.status = 'pending'
      ORDER BY c.requested_at
    `).all() : [],
    loans: section === 'all' || section === 'loans' ? db.prepare(`
      SELECT l.*, u.first_name, u.last_name, u.email,
        (u.first_name || ' ' || u.last_name) as user_name,
        l.loan_amount as principal_amount,
        l.monthly_repayment as monthly_payment,
        l.total_repayment as total_amount,
        l.loan_term_months as term_months
      FROM loans l
      JOIN users u ON l.user_id = u.id
      WHERE l.status = 'pending'
      ORDER BY l.requested_at
    `).all() : [],
    bills: section === 'all' || section === 'bills' ? db.prepare(`
      SELECT bp.*, u.first_name, u.last_name, u.email, a.account_name,
        (u.first_name || ' ' || u.last_name) as user_name,
        bp.reference_number as customer_ref
      FROM bill_payments bp
      JOIN users u ON bp.user_id = u.id
      JOIN accounts a ON bp.account_id = a.id
      WHERE bp.status = 'pending'
      ORDER BY bp.created_at
    `).all() : []
  };

  res.render('admin/approvals', {
    title: 'Approvals - United Credit Bank',
    page: 'admin-approvals',
    ...data,
    section,
    pendingKYC: data.kyc,
    pendingTransfers: data.transfers,
    pendingCards: data.cards,
    pendingLoans: data.loans,
    pendingBills: data.bills
  });
});

router.post('/kyc/:id/approve', requireAdmin, async (req, res) => {
  const kycId = req.params.id;
  const kyc = db.prepare('SELECT * FROM kyc WHERE id = ? AND status = ?').get(kycId, 'pending');
  if (!kyc) {
    return res.json({ success: false, message: 'KYC not found or already processed' });
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE kyc SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', req.session.userId, kycId);
    db.prepare('UPDATE users SET is_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(kyc.user_id);
  });
  tx();

  await syncUserBundle(kyc.user_id);

  addAuditLog(req.session.userId, 'APPROVE_KYC', 'kyc', kycId, `Approved KYC #${kycId} for user ${kyc.user_id}`, req.ip);
  addNotification(kyc.user_id, 'KYC Approved', 'Your identity verification has been approved! You now have full access to all features.', 'success');

  req.session.success = 'KYC approved successfully.';
  res.redirect('/admin/approvals?section=kyc');
});

router.post('/approvals/kyc/:id', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/kyc/${req.params.id}/approve`);
});

router.post('/kyc/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const kycId = req.params.id;
  const kyc = db.prepare('SELECT * FROM kyc WHERE id = ? AND status = ?').get(kycId, 'pending');
  if (!kyc) {
    return res.redirect('/admin/approvals?section=kyc');
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE kyc SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', reason || '', req.session.userId, kycId);
    db.prepare('UPDATE users SET is_verified = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(kyc.user_id);
  });
  tx();

  await syncUserBundle(kyc.user_id);

  addAuditLog(req.session.userId, 'REJECT_KYC', 'kyc', kycId, `Rejected KYC #${kycId}: ${reason}`, req.ip);
  addNotification(kyc.user_id, 'KYC Rejected', `Your KYC was rejected: ${reason || 'Please resubmit valid documents.'}`, 'warning');

  req.session.success = 'KYC rejected.';
  res.redirect('/admin/approvals?section=kyc');
});

router.post('/approvals/kyc/:id/reject', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/kyc/${req.params.id}/reject`);
});

router.post('/transactions/:id/approve', requireAdmin, async (req, res) => {
  const txnId = req.params.id;
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND status = ?').get(txnId, 'pending');
  if (!txn) {
    req.session.error = 'Transaction not found or already processed.';
    return res.redirect('/admin/approvals?section=transfers');
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(txn.account_id);
  const isOutgoing = OUTGOING_TYPES.has(txn.transaction_type);
  const restrictionMessage = getAccountRestrictionMessage(account, 'approve pending transactions');
  if (isOutgoing && restrictionMessage) {
    const refund = parseFloat(txn.amount) + parseFloat(txn.fee);
    const rejectTx = db.transaction(() => {
      if (refund > 0) {
        db.prepare('UPDATE accounts SET available_balance = available_balance + ? WHERE id = ?').run(refund, txn.account_id);
      }
      db.prepare('UPDATE transactions SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('rejected', restrictionMessage, req.session.userId, txnId);
    });
    rejectTx();
    await syncAccountAndTxnToFirestore(txn.account_id, txnId);
    addAuditLog(req.session.userId, 'REJECT_TRANSACTION', 'transaction', txnId, `Rejected txn #${txnId}: ${restrictionMessage}`, req.ip);
    addNotification(txn.user_id, 'Transaction Rejected', restrictionMessage, 'warning');
    queueTransactionEmail(txnId, restrictionMessage);
    req.session.error = restrictionMessage;
    return res.redirect('/admin/approvals?section=transfers');
  }

  const tx = db.transaction(() => {
    if (isOutgoing) {
      db.prepare('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(parseFloat(txn.amount) + parseFloat(txn.fee), txn.account_id);
    } else {
      db.prepare('UPDATE accounts SET balance = balance + ?, available_balance = available_balance + ? WHERE id = ?').run(txn.amount, txn.amount, txn.account_id);
    }
    db.prepare('UPDATE transactions SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('completed', req.session.userId, txnId);
  });
  tx();

  await syncAccountAndTxnToFirestore(txn.account_id, txnId);

  addAuditLog(req.session.userId, 'APPROVE_TRANSACTION', 'transaction', txnId, `Approved ${txn.transaction_type} of $${txn.amount}`, req.ip);
  addNotification(txn.user_id, 'Transaction Approved', `Your ${txn.transaction_type} of $${parseFloat(txn.amount).toLocaleString()} has been approved.`, 'success');
  queueTransactionEmail(txnId, 'Your transaction has been approved.');

  if (txn.transaction_type === 'bill_payment') {
    db.prepare("UPDATE bill_payments SET status = 'completed', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id IN (SELECT id FROM bill_payments WHERE user_id = ? AND amount = ? AND status = 'pending' ORDER BY id DESC LIMIT 1)").run(req.session.userId, txn.user_id, txn.amount);
  }

  req.session.success = 'Transaction approved successfully.';
  res.redirect('/admin/approvals?section=transfers');
});

router.post('/approvals/transfers/:id', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/transactions/${req.params.id}/approve`);
});

router.post('/transactions/:id/reject', requireAdmin, async (req, res) => {
  const { reason } = req.body;
  const txnId = req.params.id;
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND status = ?').get(txnId, 'pending');
  if (!txn) {
    return res.redirect('/admin/approvals?section=transfers');
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(txn.account_id);
  const isOutgoing = OUTGOING_TYPES.has(txn.transaction_type);
  const refund = parseFloat(txn.amount) + parseFloat(txn.fee);

  if (isOutgoing) {
    db.prepare('UPDATE accounts SET available_balance = available_balance + ? WHERE id = ?').run(refund, txn.account_id);
  }

  db.prepare('UPDATE transactions SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', reason || '', req.session.userId, txnId);
  await syncAccountAndTxnToFirestore(txn.account_id, txnId);
  addAuditLog(req.session.userId, 'REJECT_TRANSACTION', 'transaction', txnId, `Rejected txn #${txnId}: ${reason}`, req.ip);
  addNotification(txn.user_id, 'Transaction Rejected', `Your transaction was rejected: ${reason || 'Unable to process.'}`, 'warning');
  queueTransactionEmail(txnId, reason || 'Your transaction was rejected.');

  req.session.success = 'Transaction rejected.';
  res.redirect('/admin/approvals?section=transfers');
});

router.post('/approvals/transfers/:id/reject', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/transactions/${req.params.id}/reject`);
});

router.post('/cards/:id/approve', requireAdmin, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!card) {
    return res.redirect('/admin/approvals?section=cards');
  }

  db.prepare('UPDATE cards SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', req.session.userId, req.params.id);
  addAuditLog(req.session.userId, 'APPROVE_CARD', 'card', req.params.id, `Approved ${card.card_type} for user ${card.user_id}`, req.ip);
  addNotification(card.user_id, 'Card Approved', `Your ${card.card_type} has been approved and will be mailed shortly.`, 'success');

  req.session.success = 'Card approved successfully.';
  res.redirect('/admin/approvals?section=cards');
});

router.post('/approvals/cards/:id', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/cards/${req.params.id}/approve`);
});

router.post('/cards/:id/reject', requireAdmin, (req, res) => {
  const { reason } = req.body;
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!card) return res.redirect('/admin/approvals?section=cards');

  db.prepare('UPDATE cards SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', reason || '', req.session.userId, req.params.id);
  addAuditLog(req.session.userId, 'REJECT_CARD', 'card', req.params.id, `Rejected card #${req.params.id}: ${reason}`, req.ip);
  addNotification(card.user_id, 'Card Application Rejected', `Your card application was rejected: ${reason || 'Please contact support.'}`, 'warning');

  req.session.success = 'Card application rejected.';
  res.redirect('/admin/approvals?section=cards');
});

router.post('/approvals/cards/:id/reject', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/cards/${req.params.id}/reject`);
});

router.post('/loans/:id/approve', requireAdmin, async (req, res) => {
  const loanId = req.params.id;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ? AND status = ?').get(loanId, 'pending');
  if (!loan) return res.redirect('/admin/approvals?section=loans');

  const account = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1').get(loan.user_id);
  let newTxnId = null;
  const tx = db.transaction(() => {
    db.prepare('UPDATE loans SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP, disbursed_at = CURRENT_TIMESTAMP, remaining_balance = ?, next_payment_date = DATE(CURRENT_TIMESTAMP, \'+1 month\'), account_id = ? WHERE id = ?')
      .run('disbursed', req.session.userId, loan.loan_amount, account ? account.id : null, loanId);
    if (account) {
      db.prepare('UPDATE accounts SET balance = balance + ?, available_balance = available_balance + ? WHERE id = ?').run(loan.loan_amount, loan.loan_amount, account.id);
      const info = db.prepare(`
        INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, status, approved_by, approved_at)
        VALUES (?, ?, 'loan_disbursement', ?, 'AUD', ?, 'completed', ?, CURRENT_TIMESTAMP)
      `).run(account.id, loan.user_id, loan.loan_amount, `${loan.loan_type} Disbursement - Loan #${loanId}`, req.session.userId);
      newTxnId = info.lastInsertRowid;
    }
  });
  tx();

  if (account) {
    await syncAccountAndTxnToFirestore(account.id, newTxnId);
  }

  addAuditLog(req.session.userId, 'APPROVE_LOAN', 'loan', loanId, `Approved ${loan.loan_type} of $${loan.loan_amount} for user ${loan.user_id}`, req.ip);
  addNotification(loan.user_id, 'Loan Approved', `Your ${loan.loan_type} of $${parseFloat(loan.loan_amount).toLocaleString()} has been approved and disbursed!`, 'success');
  if (newTxnId) {
    queueTransactionEmail(newTxnId, 'Your approved loan has been disbursed to your account.');
  }

  req.session.success = 'Loan approved and disbursed successfully.';
  res.redirect('/admin/approvals?section=loans');
});

router.post('/approvals/loans/:id', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/loans/${req.params.id}/approve`);
});

router.post('/loans/:id/reject', requireAdmin, (req, res) => {
  const { reason } = req.body;
  const loan = db.prepare('SELECT * FROM loans WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!loan) return res.redirect('/admin/approvals?section=loans');

  db.prepare('UPDATE loans SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', reason || '', req.session.userId, req.params.id);
  addAuditLog(req.session.userId, 'REJECT_LOAN', 'loan', req.params.id, `Rejected loan #${req.params.id}: ${reason}`, req.ip);
  addNotification(loan.user_id, 'Loan Application Rejected', `Your loan application was rejected: ${reason || 'Please contact support for more info.'}`, 'warning');

  req.session.success = 'Loan application rejected.';
  res.redirect('/admin/approvals?section=loans');
});

router.post('/approvals/loans/:id/reject', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/loans/${req.params.id}/reject`);
});

router.post('/bills/:id/approve', requireAdmin, async (req, res) => {
  const billId = req.params.id;
  const bill = db.prepare('SELECT * FROM bill_payments WHERE id = ? AND status = ?').get(billId, 'pending');
  if (!bill) return res.redirect('/admin/approvals?section=bills');

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(bill.account_id);
  const restrictionMessage = getAccountRestrictionMessage(account, 'approve pending bill payments');
  if (restrictionMessage) {
    db.prepare('UPDATE bill_payments SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('rejected', restrictionMessage, req.session.userId, billId);
    addAuditLog(req.session.userId, 'REJECT_BILLPAY', 'bill_payment', billId, `Rejected bill payment #${billId}: ${restrictionMessage}`, req.ip);
    addNotification(bill.user_id, 'Bill Payment Rejected', restrictionMessage, 'warning');
    req.session.error = restrictionMessage;
    return res.redirect('/admin/approvals?section=bills');
  }

  let newTxnId = null;
  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET balance = balance - ?, available_balance = available_balance - ? WHERE id = ?').run(bill.amount, bill.amount, bill.account_id);
    db.prepare('UPDATE bill_payments SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('completed', req.session.userId, billId);
    const info = db.prepare(`
      INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, reference, status, approved_by, approved_at)
      VALUES (?, ?, 'bill_payment', ?, 'AUD', ?, ?, 'completed', ?, CURRENT_TIMESTAMP)
    `).run(bill.account_id, bill.user_id, bill.amount, `Bill Payment: ${bill.biller_name}`, bill.reference_number, req.session.userId);
    newTxnId = info.lastInsertRowid;
  });
  tx();

  await syncAccountAndTxnToFirestore(bill.account_id, newTxnId);

  addAuditLog(req.session.userId, 'APPROVE_BILLPAY', 'bill_payment', billId, `Approved bill payment of $${bill.amount} to ${bill.biller_name}`, req.ip);
  addNotification(bill.user_id, 'Bill Payment Approved', `Your $${parseFloat(bill.amount).toLocaleString()} payment to ${bill.biller_name} has been approved.`, 'success');
  if (newTxnId) {
    queueTransactionEmail(newTxnId, 'Your bill payment has been approved and processed.');
  }

  req.session.success = 'Bill payment approved successfully.';
  res.redirect('/admin/approvals?section=bills');
});

router.post('/approvals/bills/:id', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/bills/${req.params.id}/approve`);
});

router.post('/bills/:id/reject', requireAdmin, (req, res) => {
  const { reason } = req.body;
  const bill = db.prepare('SELECT * FROM bill_payments WHERE id = ? AND status = ?').get(req.params.id, 'pending');
  if (!bill) return res.redirect('/admin/approvals?section=bills');

  db.prepare('UPDATE accounts SET available_balance = available_balance + ? WHERE id = ?').run(bill.amount, bill.account_id);
  db.prepare('UPDATE bill_payments SET status = ?, rejection_reason = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', reason || '', req.session.userId, req.params.id);
  addAuditLog(req.session.userId, 'REJECT_BILLPAY', 'bill_payment', req.params.id, `Rejected bill payment #${req.params.id}: ${reason}`, req.ip);
  addNotification(bill.user_id, 'Bill Payment Rejected', `Your payment to ${bill.biller_name} was rejected: ${reason || 'Please try again.'}`, 'warning');

  req.session.success = 'Bill payment rejected.';
  res.redirect('/admin/approvals?section=bills');
});

router.post('/approvals/bills/:id/reject', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/bills/${req.params.id}/reject`);
});

router.get('/accounts', requireAdmin, (req, res) => {
  const { search, type, status } = req.query;
  let query = `
    SELECT a.*, u.first_name, u.last_name, u.email, u.is_frozen
      , (u.first_name || ' ' || u.last_name) as user_name
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    query += ' AND (a.account_number LIKE ? OR a.account_name LIKE ? OR u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  if (type && type !== 'all') { query += ' AND a.account_type = ?'; params.push(type); }
  if (status && status !== 'all') { query += ' AND a.status = ?'; params.push(status); }

  query += ' ORDER BY a.opened_date DESC LIMIT 500';
  const accounts = db.prepare(query).all(...params);

  res.render('admin/accounts', {
    title: 'Account Management - United Credit Bank',
    page: 'admin-accounts',
    accounts,
    filters: req.query
  });
});

router.get('/accounts/:id', requireAdmin, (req, res) => {
  const account = db.prepare(`
    SELECT a.*, u.first_name, u.last_name, u.email, u.is_frozen
      , (u.first_name || ' ' || u.last_name) as user_name
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!account) {
    req.session.error = 'Account not found.';
    return res.redirect('/admin/accounts');
  }

  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE account_id = ?
    ORDER BY created_at DESC
    LIMIT 100
  `).all(req.params.id);

  res.render('admin/account-detail', {
    title: `Account ${account.account_number} - United Credit Bank`,
    page: 'admin-accounts',
    account,
    transactions
  });
});

router.post('/accounts/:id/update', requireAdmin, (req, res) => {
  const accountId = req.params.id;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    req.session.error = 'Account not found.';
    return res.redirect('/admin/accounts');
  }

  const {
    account_number,
    account_type,
    account_name,
    currency,
    branch,
    bsb,
    interest_rate,
    balance,
    available_balance,
    status
  } = req.body;
  const normalizedStatus = String(status || 'active').toLowerCase();

  const duplicate = db.prepare('SELECT id FROM accounts WHERE account_number = ? AND id != ?').get(account_number, accountId);
  if (duplicate) {
    req.session.error = 'That account number is already in use.';
    return res.redirect(`/admin/accounts/${accountId}`);
  }

  if (!ACCOUNT_STATUS_OPTIONS.has(normalizedStatus)) {
    req.session.error = 'Invalid account status selected.';
    return res.redirect(`/admin/accounts/${accountId}`);
  }

  const newBalance = parseMoney(balance);
  const newAvailable = parseMoney(available_balance);
  const balanceDelta = newBalance - parseMoney(account.balance);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE accounts
      SET account_number = ?, account_type = ?, account_name = ?, currency = ?, branch = ?, bsb = ?, interest_rate = ?, balance = ?, available_balance = ?, status = ?
      WHERE id = ?
    `).run(
      account_number,
      account_type,
      account_name,
      currency || 'AUD',
      branch || 'Sydney CBD',
      bsb || '082-987',
      parseMoney(interest_rate),
      newBalance,
      newAvailable,
      normalizedStatus,
      accountId
    );

    if (Math.abs(balanceDelta) > 0.0001) {
      db.prepare(`
        INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, status, created_at, approved_by, approved_at)
        VALUES (?, ?, 'admin_adjustment', ?, ?, ?, 'completed', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      `).run(
        accountId,
        account.user_id,
        balanceDelta,
        currency || account.currency || 'AUD',
        `Admin balance correction on account ${account.account_number}`,
        req.session.userId
      );
    }
  });
  tx();

  let restrictionSummary = null;
  if (NON_OPERABLE_ACCOUNT_STATUSES.has(normalizedStatus)) {
    const reason = `Rejected automatically because account ${account.account_number} was marked ${normalizedStatus} by an administrator.`;
    restrictionSummary = resolveAccountRestrictions(accountId, req.session.userId, reason);
  }

  addAuditLog(req.session.userId, 'UPDATE_ACCOUNT', 'account', accountId, `Updated account ${account.account_number} details and balances`, req.ip);
  addNotification(account.user_id, 'Account Updated', `Your ${account.account_type} account details were updated by an administrator.`, 'info');

  req.session.success = restrictionSummary && (restrictionSummary.transactionsRejected || restrictionSummary.billsRejected)
    ? `Account updated. Rejected ${restrictionSummary.transactionsRejected} pending transaction(s) and ${restrictionSummary.billsRejected} pending bill(s) because the account is ${normalizedStatus}.`
    : 'Account details updated successfully.';
  res.redirect(`/admin/accounts/${accountId}`);
});

router.post('/accounts/:id/update-status', requireAdmin, (req, res) => {
  const status = String(req.body.status || 'active').toLowerCase();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.redirect('/admin/accounts');

  if (!ACCOUNT_STATUS_OPTIONS.has(status)) {
    req.session.error = 'Invalid account status selected.';
    return res.redirect(`/admin/accounts/${req.params.id}`);
  }

  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, req.params.id);
  const restrictionSummary = NON_OPERABLE_ACCOUNT_STATUSES.has(status)
    ? resolveAccountRestrictions(req.params.id, req.session.userId, `Rejected automatically because account ${account.account_number} was marked ${status} by an administrator.`)
    : null;
  addAuditLog(req.session.userId, 'UPDATE_ACCOUNT_STATUS', 'account', req.params.id, `Set account ${account.account_number} to ${status}`, req.ip);
  addNotification(account.user_id, 'Account Status Updated', `Your ${account.account_type} account (${account.account_number.slice(-4)}) status is now ${status}.`, 'info');

  req.session.success = restrictionSummary && (restrictionSummary.transactionsRejected || restrictionSummary.billsRejected)
    ? `Account status updated to ${status}. Rejected ${restrictionSummary.transactionsRejected} pending transaction(s) and ${restrictionSummary.billsRejected} pending bill(s).`
    : `Account status updated to ${status}.`;
  res.redirect(`/admin/accounts/${req.params.id}`);
});

router.post('/accounts/:id/status', requireAdmin, (req, res) => {
  res.redirect(307, `/admin/accounts/${req.params.id}/update-status`);
});

router.post('/accounts/adjust', requireAdmin, (req, res) => {
  const accountId = req.body.account_id;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    req.session.error = 'Account not found.';
    return res.redirect('/admin/accounts');
  }

  req.body.adjustment_type = req.body.adjustment_type || req.body.type;
  req.body.reason = req.body.reason || req.body.notes;
  return res.redirect(307, `/admin/users/${account.user_id}/adjust-balance`);
});

router.get('/cards', requireAdmin, (req, res) => {
  const cards = db.prepare(`
    SELECT c.*, u.first_name, u.last_name, u.email, a.account_number
      , (u.first_name || ' ' || u.last_name) as user_name
    FROM cards c
    JOIN users u ON c.user_id = u.id
    JOIN accounts a ON c.account_id = a.id
    ORDER BY c.requested_at DESC
    LIMIT 200
  `).all();

  res.render('admin/cards', {
    title: 'Card Management - United Credit Bank',
    page: 'admin-cards',
    cards
  });
});

router.get('/loans', requireAdmin, (req, res) => {
  const loans = db.prepare(`
    SELECT l.*, u.first_name, u.last_name, u.email
      , (u.first_name || ' ' || u.last_name) as user_name
      , l.loan_amount as principal_amount
      , l.monthly_repayment as monthly_payment
      , l.total_repayment as total_amount
      , l.loan_term_months as term_months
      , (COALESCE(l.total_repayment, 0) - COALESCE(l.remaining_balance, l.loan_amount)) as amount_paid
    FROM loans l
    JOIN users u ON l.user_id = u.id
    ORDER BY l.requested_at DESC
    LIMIT 200
  `).all();

  loans.forEach(l => {
    l.payment_count = db.prepare('SELECT COUNT(*) as c FROM loan_payments WHERE loan_id = ?').get(l.id).c;
  });

  res.render('admin/loans', {
    title: 'Loan Management - United Credit Bank',
    page: 'admin-loans',
    loans
  });
});

router.get('/transactions/new', requireAdmin, (req, res) => {
  const accounts = db.prepare(`
    SELECT a.*, u.first_name, u.last_name, u.email,
      (u.first_name || ' ' || u.last_name) as user_name
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    ORDER BY u.first_name, u.last_name, a.account_type
  `).all();
  const resolvedFilters = { ...req.query };
  if (!resolvedFilters.account_id && resolvedFilters.user_id) {
    const firstUserAccount = accounts.find(acc => String(acc.user_id) === String(resolvedFilters.user_id));
    if (firstUserAccount) {
      resolvedFilters.account_id = String(firstUserAccount.id);
    }
  }

  res.render('admin/transaction-form', {
    title: 'Create Transaction - United Credit Bank',
    page: 'admin-transactions',
    transaction: null,
    accounts,
    filters: resolvedFilters
  });
});

router.post('/transactions/create', requireAdmin, async (req, res) => {
  const payload = buildTransactionPayload(req.body);
  const account = db.prepare(`
    SELECT a.*, u.first_name, u.last_name
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    WHERE a.id = ?
  `).get(payload.account_id);

  if (!account) {
    req.session.error = 'Account not found for transaction creation.';
    return res.redirect('/admin/transactions/new');
  }

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO transactions (
        account_id, user_id, transaction_type, amount, currency, description, reference,
        recipient_name, recipient_account, recipient_bsb, recipient_bank, swift_code, iban,
        country, status, fee, exchange_rate, converted_amount, approved_by, approved_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.account_id,
      account.user_id,
      payload.transaction_type,
      payload.amount,
      payload.currency,
      payload.description,
      payload.reference,
      payload.recipient_name,
      payload.recipient_account,
      payload.recipient_bsb,
      payload.recipient_bank,
      payload.swift_code,
      payload.iban,
      payload.country,
      payload.status,
      payload.fee,
      payload.exchange_rate,
      payload.converted_amount,
      payload.status === 'pending' ? null : req.session.userId,
      payload.status === 'pending' ? null : payload.approved_at,
      payload.created_at
    );

    applyAccountImpact(payload.account_id, getTransactionImpact(payload));
    return result.lastInsertRowid;
  });

  const transactionId = tx();

  if (isFirestoreEnabled()) {
    try {
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(payload.account_id);
      const newTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(transactionId);
      await Promise.all([
        syncAccountToFirestore(updatedAccount),
        syncTransactionToFirestore(newTxn)
      ]);
    } catch (error) {
      console.error('Failed to sync admin-created transaction to Firestore:', error);
      req.session.error = 'Transaction created locally, but Firestore sync failed.';
    }
  }

  addAuditLog(req.session.userId, 'CREATE_TRANSACTION', 'transaction', transactionId, `Created ${payload.transaction_type} on account ${account.account_number}`, req.ip);
  addNotification(account.user_id, 'Account Transaction Added', `An administrator added a ${payload.transaction_type.replace(/_/g, ' ')} transaction to your account.`, payload.status === 'completed' ? 'info' : 'warning');
  queueTransactionEmail(transactionId, 'An administrator created this transaction on your account.');

  if (!req.session.error) {
    req.session.success = 'Transaction created successfully.';
  }
  res.redirect(`/admin/transactions/${transactionId}`);
});

router.get('/transactions', requireAdmin, (req, res) => {
  const { type, status, from_date, to_date, min_amount, max_amount, search, user: userId, account: accountId } = req.query;
  let query = `
    SELECT t.*, u.first_name, u.last_name, u.email, a.account_name, a.account_number
      , (u.first_name || ' ' || u.last_name) as user_name
    FROM transactions t
    JOIN users u ON t.user_id = u.id
    JOIN accounts a ON t.account_id = a.id
    WHERE 1=1
  `;
  const params = [];

  if (userId) { query += ' AND t.user_id = ?'; params.push(userId); }
  if (accountId) { query += ' AND t.account_id = ?'; params.push(accountId); }
  if (type && type !== 'all') { query += ' AND t.transaction_type = ?'; params.push(type); }
  if (status && status !== 'all') { query += ' AND t.status = ?'; params.push(status); }
  if (from_date) { query += ' AND DATE(t.created_at) >= ?'; params.push(from_date); }
  if (to_date) { query += ' AND DATE(t.created_at) <= ?'; params.push(to_date); }
  if (min_amount) { query += ' AND t.amount >= ?'; params.push(min_amount); }
  if (max_amount) { query += ' AND t.amount <= ?'; params.push(max_amount); }
  if (search) {
    query += ' AND (u.email LIKE ? OR u.first_name LIKE ? OR u.last_name LIKE ? OR t.description LIKE ? OR t.reference LIKE ? OR CAST(t.id AS TEXT) LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s);
  }

  query += ' ORDER BY t.created_at DESC LIMIT 500';
  const transactions = db.prepare(query).all(...params);
  const accounts = db.prepare(`
    SELECT a.id, a.account_number, a.account_type, u.first_name, u.last_name
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    ORDER BY u.first_name, u.last_name, a.account_type
  `).all();

  const totals = {
    volume: transactions.reduce((s, t) => s + parseFloat(t.amount), 0),
    completed: transactions.filter(t => t.status === 'completed').length,
    pending: transactions.filter(t => t.status === 'pending').length
  };

  res.render('admin/transactions', {
    title: 'All Transactions - United Credit Bank',
    page: 'admin-transactions',
    transactions,
    accounts,
    filters: req.query,
    totals
  });
});

router.get('/transactions/:id', requireAdmin, (req, res) => {
  const transaction = db.prepare(`
    SELECT t.*, u.first_name, u.last_name, u.email, a.account_number, a.account_name
      , (u.first_name || ' ' || u.last_name) as user_name
    FROM transactions t
    JOIN users u ON t.user_id = u.id
    JOIN accounts a ON t.account_id = a.id
    WHERE t.id = ?
  `).get(req.params.id);

  if (!transaction) {
    req.session.error = 'Transaction not found.';
    return res.redirect('/admin/transactions');
  }

  const accounts = db.prepare(`
    SELECT a.*, u.first_name, u.last_name, u.email,
      (u.first_name || ' ' || u.last_name) as user_name
    FROM accounts a
    JOIN users u ON a.user_id = u.id
    ORDER BY u.first_name, u.last_name, a.account_type
  `).all();

  res.render('admin/transaction-form', {
    title: `Transaction #${transaction.id} - United Credit Bank`,
    page: 'admin-transactions',
    transaction,
    accounts,
    filters: {}
  });
});

router.post('/transactions/:id/update', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) {
    req.session.error = 'Transaction not found.';
    return res.redirect('/admin/transactions');
  }

  const payload = buildTransactionPayload(req.body);
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(payload.account_id);
  if (!account) {
    req.session.error = 'Target account not found.';
    return res.redirect(`/admin/transactions/${req.params.id}`);
  }

  const tx = db.transaction(() => {
    applyAccountImpact(existing.account_id, getTransactionImpact(existing), -1);
    applyAccountImpact(payload.account_id, getTransactionImpact(payload), 1);

    db.prepare(`
      UPDATE transactions
      SET account_id = ?, user_id = ?, transaction_type = ?, amount = ?, currency = ?, description = ?, reference = ?,
          recipient_name = ?, recipient_account = ?, recipient_bsb = ?, recipient_bank = ?, swift_code = ?, iban = ?,
          country = ?, status = ?, fee = ?, exchange_rate = ?, converted_amount = ?, approved_by = ?, approved_at = ?, rejection_reason = ?, created_at = ?
      WHERE id = ?
    `).run(
      payload.account_id,
      account.user_id,
      payload.transaction_type,
      payload.amount,
      payload.currency,
      payload.description,
      payload.reference,
      payload.recipient_name,
      payload.recipient_account,
      payload.recipient_bsb,
      payload.recipient_bank,
      payload.swift_code,
      payload.iban,
      payload.country,
      payload.status,
      payload.fee,
      payload.exchange_rate,
      payload.converted_amount,
      payload.status === 'pending' ? null : req.session.userId,
      payload.status === 'pending' ? null : payload.approved_at,
      req.body.rejection_reason || '',
      payload.created_at,
      req.params.id
    );
  });
  tx();

  addAuditLog(req.session.userId, 'UPDATE_TRANSACTION', 'transaction', req.params.id, `Edited transaction #${req.params.id}`, req.ip);
  addNotification(account.user_id, 'Transaction Updated', `An administrator updated transaction #${req.params.id} on your account.`, 'info');

  req.session.success = 'Transaction updated successfully.';
  res.redirect(`/admin/transactions/${req.params.id}`);
});

router.get('/audit-logs', requireAdmin, (req, res) => {
  const logs = db.prepare(`
    SELECT al.*, u.first_name, u.last_name, u.email,
      (u.first_name || ' ' || u.last_name) as admin_name
    FROM audit_logs al
    JOIN users u ON al.admin_id = u.id
    ORDER BY al.created_at DESC
    LIMIT 500
  `).all();

  res.render('admin/audit-logs', {
    title: 'Audit Logs - United Credit Bank',
    page: 'admin-audit',
    logs,
    auditLogs: logs
  });
});

router.get('/reports', requireAdmin, (req, res) => {
  const monthlyUsers = db.prepare(`
    SELECT strftime('%Y-%m', u.created_at) as month, COUNT(*) as new_customers
    FROM users u
    WHERE u.is_admin = 0
    GROUP BY strftime('%Y-%m', u.created_at)
    ORDER BY month DESC
    LIMIT 12
  `).all();
  const monthlyTransactions = db.prepare(`
    SELECT
      strftime('%Y-%m', t.created_at) as month,
      SUM(CASE WHEN t.transaction_type IN ('deposit', 'loan_disbursement') AND t.status = 'completed' THEN ABS(t.amount) ELSE 0 END) as deposits,
      SUM(CASE WHEN t.transaction_type IN ('withdrawal', 'local_transfer', 'international_transfer', 'bill_payment', 'loan_payment') AND t.status = 'completed' THEN ABS(t.amount) ELSE 0 END) as withdrawals
    FROM transactions t
    GROUP BY strftime('%Y-%m', t.created_at)
    ORDER BY month DESC
    LIMIT 12
  `).all();

  const monthlyMap = new Map();
  monthlyUsers.forEach(row => {
    monthlyMap.set(row.month, {
      month: row.month,
      new_customers: row.new_customers || 0,
      deposits: 0,
      withdrawals: 0
    });
  });
  monthlyTransactions.forEach(row => {
    const existing = monthlyMap.get(row.month) || {
      month: row.month,
      new_customers: 0,
      deposits: 0,
      withdrawals: 0
    };
    existing.deposits = row.deposits || 0;
    existing.withdrawals = row.withdrawals || 0;
    monthlyMap.set(row.month, existing);
  });

  const monthlyData = Array.from(monthlyMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);

  const typeBreakdown = db.prepare(`
    SELECT transaction_type as type, COUNT(*) as count, COALESCE(SUM(ABS(amount)), 0) as total
    FROM transactions
    WHERE status = 'completed' AND DATE(created_at) >= DATE('now', '-30 days')
    GROUP BY transaction_type
    ORDER BY total DESC
  `).all();

  const accountSummary = db.prepare(`
    SELECT account_type as type, COUNT(*) as count, COALESCE(SUM(balance), 0) as total_balance, COALESCE(AVG(balance), 0) as avg_balance
    FROM accounts
    WHERE status = 'active'
    GROUP BY account_type
    ORDER BY total_balance DESC
  `).all();

  const loanSummary = db.prepare(`
    SELECT
      loan_type as type,
      COUNT(*) as count,
      COALESCE(SUM(COALESCE(remaining_balance, loan_amount)), 0) as outstanding,
      COALESCE(AVG(interest_rate), 0) as avg_rate,
      COALESCE(SUM(monthly_repayment), 0) as monthly_total
    FROM loans
    WHERE status IN ('pending', 'approved', 'disbursed', 'active')
    GROUP BY loan_type
    ORDER BY outstanding DESC
  `).all();

  const loanTotals = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(COALESCE(remaining_balance, loan_amount)), 0) as total_outstanding
    FROM loans
    WHERE status IN ('approved', 'disbursed', 'active')
  `).get();

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(fee), 0) as total
    FROM transactions
    WHERE status = 'completed' AND DATE(created_at) >= DATE('now', '-30 days')
  `).get().total;

  res.render('admin/reports', {
    title: 'Reports & Analytics - United Credit Bank',
    page: 'admin-reports',
    revenue,
    monthlyData,
    typeBreakdown,
    accountSummary,
    loanSummary,
    loanTotals
  });
});

router.get('/settings', requireAdmin, (req, res) => {
  const admins = db.prepare('SELECT * FROM users WHERE is_admin = 1').all();
  res.render('admin/settings', {
    title: 'Admin Settings - United Credit Bank',
    page: 'admin-settings',
    admins
  });
});

router.post('/admins/create', requireAdmin, async (req, res) => {
  const { first_name, last_name, email, phone, password } = req.body;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    req.session.error = 'Email already registered.';
    return res.redirect('/admin/settings');
  }

  const hashed = await bcrypt.hash(password || 'AdminPass2026!', 10);
  const result = db.prepare(`
    INSERT INTO users (first_name, last_name, email, phone, password, address, city, state, postcode, country, is_admin, is_verified)
    VALUES (?, ?, ?, ?, ?, '1 Martin Place', 'Sydney', 'NSW', '2000', 'Australia', 1, 1)
  `).run(first_name, last_name, email, phone, hashed);

  db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, account_name, balance, available_balance, status)
    VALUES (?, ?, 'Admin Account', ?, 0, 0, 'active')
  `).run(result.lastInsertRowid, generateAcc(), `${first_name} ${last_name}`);

  addAuditLog(req.session.userId, 'CREATE_ADMIN', 'user', result.lastInsertRowid, `Created admin: ${first_name} ${last_name}`, req.ip);
  req.session.success = `Admin ${first_name} ${last_name} created.`;
  res.redirect('/admin/settings');
});

module.exports = router;
