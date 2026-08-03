const { db } = require('../database');

const NON_OPERABLE_ACCOUNT_STATUSES = new Set(['frozen', 'blocked', 'closed']);

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    req.session.error = 'Please login to access this page.';
    return res.redirect('/auth/login');
  }
  next();
}

function requireVerified(req, res, next) {
  if (req.session.user && req.session.user.is_frozen === 1) {
    req.session.error = 'Your account has been frozen. Please contact support.';
    return res.redirect('/auth/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    req.session.error = 'Please login to access this page.';
    return res.redirect('/auth/login');
  }
  if (!req.session.user || Number(req.session.user.is_admin) !== 1) {
    req.session.error = 'Access denied. Admin privileges required.';
    return res.redirect('/user/dashboard');
  }
  next();
}

function getUserAccounts(userId, options = {}) {
  let query = 'SELECT * FROM accounts WHERE user_id = ?';
  const params = [userId];

  if (options.operableOnly) {
    query += " AND status = 'active'";
  }

  query += ' ORDER BY id';
  return db.prepare(query).all(...params);
}

function getAccountStatusMessage(account, action = 'complete this action') {
  if (!account) {
    return 'Invalid account selected.';
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

function isAccountOperable(account) {
  return !getAccountStatusMessage(account);
}

function getPrimaryAccount(userId) {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
}

function getRecentTransactions(userId, limit = 10) {
  return db.prepare(`
    SELECT t.*, a.account_number, a.account_name
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function getNotifications(userId, limit = 10) {
  return db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function addNotification(userId, title, message, type = 'info') {
  return db.prepare(`
    INSERT INTO notifications (user_id, title, message, type)
    VALUES (?, ?, ?, ?)
  `).run(userId, title, message, type);
}

function addAuditLog(adminId, action, targetType, targetId, details, ip) {
  return db.prepare(`
    INSERT INTO audit_logs (admin_id, action, target_type, target_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(adminId, action, targetType, targetId, details, ip);
}

function formatCurrency(amount, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: currency
  }).format(amount || 0);
}

function generateAccountNumber() {
  return '200' + Math.random().toString().slice(2, 10);
}

module.exports = {
  requireAuth,
  requireVerified,
  requireAdmin,
  getUserAccounts,
  getAccountStatusMessage,
  isAccountOperable,
  getPrimaryAccount,
  getRecentTransactions,
  getNotifications,
  addNotification,
  addAuditLog,
  formatCurrency,
  generateAccountNumber
};
