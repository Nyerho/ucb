const express = require('express');
const { db } = require('../database');
const { requireAuth, requireVerified, getUserAccounts, getAccountStatusMessage, generateAccountNumber } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const accounts = getUserAccounts(req.session.userId);
  res.render('accounts/index', {
    title: 'My Accounts - United Credit Bank',
    page: 'accounts',
    accounts
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!account) {
    req.session.error = 'Account not found.';
    return res.redirect('/accounts');
  }

  const transactions = db.prepare(`
    SELECT * FROM transactions
    WHERE account_id = ?
    ORDER BY created_at DESC
    LIMIT 500
  `).all(account.id);

  const totalDeposits = transactions
    .filter((t) => {
      if (t.status !== 'completed') return false;
      if (t.transaction_type === 'admin_adjustment') return parseFloat(t.amount) > 0;
      return ['deposit', 'loan_disbursement'].includes(t.transaction_type);
    })
    .reduce((sum, t) => sum + Math.abs(parseFloat(t.amount) || 0), 0);
  const totalWithdrawals = transactions
    .filter((t) => {
      if (t.status !== 'completed') return false;
      if (t.transaction_type === 'admin_adjustment') return parseFloat(t.amount) < 0;
      return ['withdrawal', 'local_transfer', 'international_transfer', 'bill_payment', 'loan_payment'].includes(t.transaction_type);
    })
    .reduce((sum, t) => sum + Math.abs(parseFloat(t.amount) || 0) + Math.abs(parseFloat(t.fee) || 0), 0);

  res.render('accounts/detail', {
    title: `${account.account_name} - United Credit Bank`,
    page: 'accounts',
    account,
    transactions,
    totalDeposits,
    totalWithdrawals
  });
});

router.get('/open/new', requireAuth, requireVerified, (req, res) => {
  const accountTypes = [
    { type: 'Everyday Savings', name: 'Everyday Savings Account', min: 0, interest: '0.50%', desc: 'Perfect for everyday banking with no monthly fees' },
    { type: 'High Interest', name: 'High Interest Savings', min: 1000, interest: '4.25%', desc: 'Earn premium interest on your savings' },
    { type: 'Term Deposit', name: 'Term Deposit', min: 5000, interest: '5.10%', desc: 'Locked term for guaranteed returns' },
    { type: 'Business', name: 'Business Account', min: 500, interest: '1.20%', desc: 'Complete business banking solution' },
    { type: 'International', name: 'Multi-Currency Account', min: 100, interest: '0.30%', desc: 'Hold and manage multiple currencies' }
  ];
  res.render('accounts/open', {
    title: 'Open New Account - United Credit Bank',
    page: 'accounts',
    accountTypes
  });
});

router.post('/open', requireAuth, requireVerified, (req, res) => {
  const { account_type, initial_deposit } = req.body;
  const accountNumber = generateAccountNumber();
  const user = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.session.userId);

  const insertAccount = db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, account_name, balance, available_balance, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertAccount.run(
    req.session.userId,
    accountNumber,
    account_type,
    `${user.first_name} ${user.last_name}`,
    initial_deposit || 0,
    initial_deposit || 0,
    'active'
  );

  req.session.success = `Your ${account_type} account has been opened successfully!`;
  res.redirect('/accounts');
});

router.post('/:id/close', requireAuth, requireVerified, (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!account) {
    req.session.error = 'Account not found.';
    return res.redirect('/accounts');
  }

  const restrictionMessage = getAccountStatusMessage(account, 'be closed');
  if (restrictionMessage) {
    req.session.error = restrictionMessage;
    return res.redirect(`/accounts/${req.params.id}`);
  }

  if (parseFloat(account.balance) > 0) {
    req.session.error = 'Please transfer remaining balance before closing.';
    return res.redirect(`/accounts/${req.params.id}`);
  }

  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run('closed', req.params.id);
  req.session.success = 'Account closed successfully.';
  res.redirect('/accounts');
});

module.exports = router;
