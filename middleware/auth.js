const { db } = require('../database');

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
  if (!req.session.user || req.session.user.is_admin !== 1) {
    req.session.error = 'Access denied. Admin privileges required.';
    return res.redirect('/user/dashboard');
  }
  next();
}

function getUserAccounts(userId) {
  return db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId);
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
  getPrimaryAccount,
  getRecentTransactions,
  getNotifications,
  addNotification,
  addAuditLog,
  formatCurrency,
  generateAccountNumber
};
