const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { db } = require('../database');
const {
  requireAuth,
  requireVerified,
  getUserAccounts,
  getRecentTransactions,
  getNotifications
} = require('../middleware/auth');

const router = express.Router();

function hasTransferPin(user) {
  return Boolean(user && user.transfer_pin_hash);
}

function isIncomingTransaction(tx) {
  if (!tx || tx.status !== 'completed') {
    return false;
  }
  if (tx.transaction_type === 'admin_adjustment') {
    return parseFloat(tx.amount) > 0;
  }
  return ['deposit', 'loan_disbursement'].includes(tx.transaction_type);
}

function isOutgoingTransaction(tx) {
  if (!tx || tx.status !== 'completed') {
    return false;
  }
  if (tx.transaction_type === 'admin_adjustment') {
    return parseFloat(tx.amount) < 0;
  }
  return ['withdrawal', 'local_transfer', 'international_transfer', 'bill_payment', 'loan_payment'].includes(tx.transaction_type);
}

function getCreditTotal(transactions) {
  return transactions.reduce((sum, tx) => {
    if (!isIncomingTransaction(tx)) {
      return sum;
    }
    return sum + Math.abs(parseFloat(tx.amount) || 0);
  }, 0);
}

function getDebitTotal(transactions) {
  return transactions.reduce((sum, tx) => {
    if (!isOutgoingTransaction(tx)) {
      return sum;
    }
    return sum + Math.abs(parseFloat(tx.amount) || 0) + Math.abs(parseFloat(tx.fee) || 0);
  }, 0);
}

router.get('/dashboard', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const accounts = getUserAccounts(userId);
  const transactions = getRecentTransactions(userId, 25);
  const notifications = getNotifications(userId, 5);
  const kyc = db.prepare('SELECT * FROM kyc WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  const cards = db.prepare('SELECT * FROM cards WHERE user_id = ?').all(userId);
  const loans = db.prepare('SELECT * FROM loans WHERE user_id = ?').all(userId);
  const completedTransactions = db.prepare(`
    SELECT *
    FROM transactions
    WHERE user_id = ? AND status = 'completed'
    ORDER BY created_at DESC
  `).all(userId);

  const totalBalance = accounts.reduce((sum, acc) => sum + (parseFloat(acc.balance) || 0), 0);
  const totalAvailable = accounts.reduce((sum, acc) => sum + (parseFloat(acc.available_balance) || 0), 0);
  const totalCardCredit = cards.reduce((sum, card) => sum + (parseFloat(card.credit_limit) || 0), 0);
  const totalCredits = getCreditTotal(completedTransactions);
  const totalDebits = getDebitTotal(completedTransactions);
  const pendingTransfers = db.prepare('SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND status = ?').get(userId, 'pending').count;
  const pendingCards = db.prepare('SELECT COUNT(*) as count FROM cards WHERE user_id = ? AND status = ?').get(userId, 'pending').count;
  const pendingLoans = db.prepare('SELECT COUNT(*) as count FROM loans WHERE user_id = ? AND status = ?').get(userId, 'pending').count;

  res.render('user/dashboard', {
    title: 'Dashboard - United Credit Bank',
    page: 'dashboard',
    user,
    accounts,
    transactions,
    notifications,
    kyc,
    cards,
    loans,
    totalBalance,
    totalAvailable,
    totalCardCredit,
    totalCredits,
    totalDebits,
    pendingTransfers,
    pendingCards,
    pendingLoans
  });
});

router.get('/profile', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.render('user/profile', {
    title: 'My Profile - United Credit Bank',
    page: 'profile',
    user
  });
});

router.post('/profile', requireAuth, [
  body('first_name').trim().isLength({ min: 2 }),
  body('last_name').trim().isLength({ min: 2 }),
  body('phone').isLength({ min: 6 }),
  body('email').isEmail()
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.error = 'Please check your input and try again.';
    return res.redirect('/user/profile');
  }

  const { first_name, last_name, email, phone, address, city, state, postcode, date_of_birth } = req.body;
  const userId = req.session.userId;

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId);
  if (existingEmail) {
    req.session.error = 'This email is already in use.';
    return res.redirect('/user/profile');
  }

  db.prepare(`
    UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, address = ?, city = ?, state = ?, postcode = ?, date_of_birth = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(first_name, last_name, email, phone, address, city, state, postcode, date_of_birth, userId);

  req.session.user.first_name = first_name;
  req.session.user.last_name = last_name;
  req.session.user.email = email;

  req.session.success = 'Profile updated successfully.';
  res.redirect('/user/profile');
});

router.get('/settings', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.render('user/settings', {
    title: 'Settings - United Credit Bank',
    page: 'settings',
    user,
    hasTransferPin: hasTransferPin(user)
  });
});

router.post('/change-password', requireAuth, [
  body('current_password').exists(),
  body('new_password').isLength({ min: 8 }),
  body('confirm_password').custom((value, { req }) => value === req.body.new_password)
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.error = 'Password must be at least 8 characters and match confirmation.';
    return res.redirect('/user/settings');
  }

  const { current_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  const isValid = await bcrypt.compare(current_password, user.password);
  if (!isValid) {
    req.session.error = 'Current password is incorrect.';
    return res.redirect('/user/settings');
  }

  const hashedPassword = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hashedPassword, req.session.userId);

  req.session.success = 'Password changed successfully.';
  res.redirect('/user/settings');
});

router.post('/settings/transfer-pin', requireAuth, [
  body('current_password').exists(),
  body('transfer_pin').matches(/^\d{4,6}$/),
  body('confirm_transfer_pin').custom((value, { req }) => value === req.body.transfer_pin)
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.session.error = 'Transfer PIN must be 4 to 6 digits and match the confirmation field.';
    return res.redirect('/user/settings');
  }

  const { current_password, transfer_pin } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  const validPassword = await bcrypt.compare(current_password, user.password);
  if (!validPassword) {
    req.session.error = 'Current password is incorrect.';
    return res.redirect('/user/settings');
  }

  const pinHash = await bcrypt.hash(transfer_pin, 10);
  db.prepare(`
    UPDATE users
    SET transfer_pin_hash = ?, transfer_pin_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(pinHash, req.session.userId);

  req.session.success = hasTransferPin(user)
    ? 'Transfer PIN updated successfully.'
    : 'Transfer PIN created successfully.';
  res.redirect('/user/settings');
});

router.get('/statements', requireAuth, (req, res) => {
  const accounts = getUserAccounts(req.session.userId);
  const selectedAccount = req.query.account ? accounts.find(a => a.id == req.query.account) : accounts[0];
  
  let transactions = [];
  let statementCredits = 0;
  let statementDebits = 0;
  if (selectedAccount) {
    transactions = db.prepare(`
      SELECT * FROM transactions
      WHERE account_id = ?
      ORDER BY created_at DESC
      LIMIT 500
    `).all(selectedAccount.id);
    statementCredits = getCreditTotal(transactions);
    statementDebits = getDebitTotal(transactions);
  }

  res.render('user/statements', {
    title: 'Account Statements - United Credit Bank',
    page: 'statements',
    accounts,
    selectedAccount,
    transactions,
    statementCredits,
    statementDebits
  });
});

router.get('/beneficiaries', requireAuth, (req, res) => {
  const beneficiaries = db.prepare('SELECT * FROM beneficiaries WHERE user_id = ?').all(req.session.userId);
  res.render('user/beneficiaries', {
    title: 'Beneficiaries - United Credit Bank',
    page: 'beneficiaries',
    beneficiaries
  });
});

router.post('/beneficiaries/add', requireAuth, (req, res) => {
  const { name, account_number, bsb, bank_name, swift_code, iban, country, is_international } = req.body;
  db.prepare(`
    INSERT INTO beneficiaries (user_id, name, account_number, bsb, bank_name, swift_code, iban, country, is_international)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, name, account_number, bsb || '', bank_name || '', swift_code || '', iban || '', country || 'Australia', is_international ? 1 : 0);

  req.session.success = 'Beneficiary added successfully.';
  res.redirect('/user/beneficiaries');
});

router.post('/beneficiaries/delete/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM beneficiaries WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
  req.session.success = 'Beneficiary removed.';
  res.redirect('/user/beneficiaries');
});

router.get('/notifications', requireAuth, (req, res) => {
  const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.session.userId);
  res.render('user/notifications', {
    title: 'Notifications - United Credit Bank',
    page: 'notifications',
    notifications
  });
});

router.post('/notifications/read/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
  res.json({ success: true });
});

router.get('/support', requireAuth, (req, res) => {
  res.render('user/support', {
    title: 'Support - United Credit Bank',
    page: 'support'
  });
});

module.exports = router;
