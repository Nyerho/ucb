'use strict';

const { createFirestoreRepository } = require('../services/firestore-rest');
const repository = createFirestoreRepository();
const NON_OPERABLE_ACCOUNT_STATUSES = new Set(['frozen', 'blocked', 'closed']);

function requireAuth(req, res, next) {
  if (!req.auth || !req.auth.uid) {
    req.session.error = 'Please login to access this page.';
    return res.redirect('/auth/login');
  }
  next();
}

function requireVerified(req, res, next) {
  const sessionUser = req.user || null;
  if (sessionUser && (sessionUser.is_frozen === true || Number(sessionUser.is_frozen) === 1)) {
    req.session.error = 'Your account has been frozen. Please contact support.';
    return res.redirect('/auth/login');
  }
  if (!sessionUser || !(sessionUser.is_verified === true || Number(sessionUser.is_verified) === 1)) {
    req.session.error = 'Complete and approve your KYC verification before using this feature.';
    return res.redirect('/kyc');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.auth || !req.auth.uid) {
    req.session.error = 'Please login to access this page.';
    return res.redirect('/auth/login');
  }
  if (!req.user || !(req.user.is_admin === true || Number(req.user.is_admin) === 1 || req.user.role === 'admin')) {
    req.session.error = 'Access denied. Admin privileges required.';
    return res.redirect('/user/dashboard');
  }
  next();
}

async function getUserAccounts(userId, options = {}) {
  const filters = [{ field: 'user_id', op: 'EQUAL', value: String(userId) }];
  if (options.operableOnly) filters.push({ field: 'status', op: 'EQUAL', value: 'active' });
  return repository.list('accounts', filters, { orderBy: { field: 'created_at', direction: 'ASCENDING' }, limit: 100 });
}

function getAccountStatusMessage(account, action = 'complete this action') {
  if (!account) return 'Invalid account selected.';
  const status = String(account.status || 'active').toLowerCase();
  if (!NON_OPERABLE_ACCOUNT_STATUSES.has(status)) return null;
  if (status === 'frozen') return `This account is frozen and cannot be used to ${action}.`;
  if (status === 'blocked') return `This account is blocked and cannot be used to ${action}.`;
  return `This account is closed and cannot be used to ${action}.`;
}

function isAccountOperable(account) {
  return !getAccountStatusMessage(account);
}

async function getPrimaryAccount(userId) {
  const accounts = await repository.list('accounts', [{ field: 'user_id', value: String(userId) }], {
    orderBy: { field: 'created_at', direction: 'ASCENDING' }, limit: 1
  });
  return accounts[0] || null;
}

async function getRecentTransactions(userId, limit = 10) {
  const [transactions, accounts] = await Promise.all([
    repository.list('transactions', [{ field: 'user_id', value: String(userId) }], {
      orderBy: { field: 'created_at', direction: 'DESCENDING' }, limit
    }),
    repository.list('accounts', [{ field: 'user_id', value: String(userId) }], { limit: 100 })
  ]);
  const byId = new Map(accounts.map((account) => [String(account.id), account]));
  return transactions.map((transaction) => ({
    ...transaction,
    account_number: byId.get(String(transaction.account_id))?.account_number || '',
    account_name: byId.get(String(transaction.account_id))?.account_name || ''
  }));
}

async function getNotifications(userId, limit = 10) {
  return repository.list('notifications', [{ field: 'user_id', value: String(userId) }], {
    orderBy: { field: 'created_at', direction: 'DESCENDING' }, limit
  });
}

async function addNotification(userId, title, message, type = 'info') {
  return repository.create('notifications', {
    user_id: String(userId), title, message, type,
    is_read: false,
    created_at: new Date().toISOString()
  });
}

async function addAuditLog(adminId, action, targetType, targetId, details, ip) {
  return repository.create('audit_logs', {
    admin_id: String(adminId), action, target_type: targetType,
    target_id: String(targetId), details: String(details || ''),
    ip_address: ip || '', created_at: new Date().toISOString()
  });
}

function formatCurrency(amount, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(amount || 0);
}

function generateAccountNumber() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return '200' + Array.from(bytes, (value) => String(value % 10)).join('');
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
