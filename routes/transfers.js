const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const {
  requireAuth,
  requireVerified,
  getUserAccounts,
  getAccountStatusMessage,
  addNotification
} = require('../middleware/auth');
const {
  isFirestoreEnabled,
  syncAccountToFirestore,
  syncTransactionToFirestore
} = require('../services/firestore-sync');
const { sendTransactionActivityEmailById } = require('../services/email');

const router = express.Router();

const OUTGOING_TYPES = new Set(['local_transfer', 'international_transfer', 'withdrawal', 'bill_payment', 'loan_payment']);

function queueTransactionEmail(txnId, note) {
  if (!txnId) return;
  sendTransactionActivityEmailById(txnId, note ? { note } : {}).catch((error) => {
    console.error(`Failed to send transaction email for txn ${txnId}:`, error);
  });
}

function getTransferUser(userId) {
  return db.prepare('SELECT id, first_name, last_name, transfer_pin_hash FROM users WHERE id = ?').get(userId);
}

async function validateTransferPin(userId, pin) {
  const user = getTransferUser(userId);
  if (!user || !user.transfer_pin_hash) {
    return { ok: false, code: 'missing' };
  }
  if (!pin) {
    return { ok: false, code: 'required' };
  }
  const matches = await bcrypt.compare(pin, user.transfer_pin_hash);
  return { ok: matches, code: matches ? 'ok' : 'invalid' };
}

router.get('/', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId);
  const beneficiaries = db.prepare('SELECT * FROM beneficiaries WHERE user_id = ?').all(req.session.userId);
  const recent = db.prepare(`
    SELECT t.*, a.account_name as from_account
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.user_id = ? AND t.transaction_type IN ('transfer', 'international_transfer', 'local_transfer')
    ORDER BY t.created_at DESC
    LIMIT 10
  `).all(req.session.userId);

  res.render('transfers/index', {
    title: 'Transfers - United Credit Bank',
    page: 'transfers',
    accounts,
    beneficiaries,
    recent
  });
});

router.get('/local', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  const beneficiaries = db.prepare('SELECT * FROM beneficiaries WHERE user_id = ? AND is_international = 0').all(req.session.userId);
  const selectedAccountId = accounts.find(acc => String(acc.id) === String(req.query.from))?.id || accounts[0]?.id || null;
  const transferUser = getTransferUser(req.session.userId);

  res.render('transfers/local', {
    title: 'Local Transfer - United Credit Bank',
    page: 'transfers',
    accounts,
    beneficiaries,
    selectedAccountId,
    hasTransferPin: Boolean(transferUser && transferUser.transfer_pin_hash)
  });
});

router.post('/local', requireAuth, requireVerified, async (req, res) => {
  const { from_account, to_account, to_bsb, to_name, amount, description, reference, save_beneficiary, beneficiary_name, transfer_pin } = req.body;
  const pinState = await validateTransferPin(req.session.userId, transfer_pin);
  if (!pinState.ok) {
    req.session.error = pinState.code === 'missing'
      ? 'Please create your transfer PIN in Settings before making transfers.'
      : pinState.code === 'required'
        ? 'Transfer PIN is required to authorise this transfer.'
        : 'Transfer PIN is incorrect.';
    return res.redirect(pinState.code === 'missing' ? '/user/settings' : '/transfers/local');
  }

  const sourceAccount = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(from_account, req.session.userId);
  if (!sourceAccount) {
    req.session.error = 'Invalid source account.';
    return res.redirect('/transfers/local');
  }

  const restrictionMessage = getAccountStatusMessage(sourceAccount, 'make transfers');
  if (restrictionMessage) {
    req.session.error = restrictionMessage;
    return res.redirect('/transfers/local');
  }

  if (parseFloat(amount) > parseFloat(sourceAccount.available_balance)) {
    req.session.error = 'Insufficient funds available.';
    return res.redirect('/transfers/local');
  }

  if (parseFloat(amount) <= 0) {
    req.session.error = 'Please enter a valid amount.';
    return res.redirect('/transfers/local');
  }

  const fee = parseFloat(amount) > 10000 ? 15 : 0;
  const needsApproval = parseFloat(amount) >= 5000;
  const status = needsApproval ? 'pending' : 'completed';

  const insertInfo = db.prepare(`
    INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, reference, recipient_name, recipient_account, recipient_bsb, recipient_bank, status, fee)
    VALUES (?, ?, 'local_transfer', ?, 'AUD', ?, ?, ?, ?, ?, 'Australia', ?, ?)
  `).run(
    from_account,
    req.session.userId,
    amount,
    description || '',
    reference || '',
    to_name,
    to_account,
    to_bsb || '',
    status,
    fee
  );
  const txnId = insertInfo.lastInsertRowid;

  if (status === 'completed') {
    const newBalance = parseFloat(sourceAccount.balance) - parseFloat(amount) - fee;
    const newAvailable = parseFloat(sourceAccount.available_balance) - parseFloat(amount) - fee;
    db.prepare('UPDATE accounts SET balance = ?, available_balance = ? WHERE id = ?').run(newBalance, newAvailable, from_account);

    addNotification(req.session.userId, 'Transfer Completed', `$${parseFloat(amount).toLocaleString()} transferred to ${to_name}`, 'success');
  } else {
    const holdAmount = parseFloat(amount) + fee;
    const newAvailable = parseFloat(sourceAccount.available_balance) - holdAmount;
    db.prepare('UPDATE accounts SET available_balance = ? WHERE id = ?').run(newAvailable, from_account);

    addNotification(req.session.userId, 'Transfer Pending', `Transfer of $${parseFloat(amount).toLocaleString()} is awaiting approval`, 'warning');
  }

  if (isFirestoreEnabled()) {
    try {
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(from_account);
      const newTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
      await Promise.all([
        syncAccountToFirestore(updatedAccount),
        syncTransactionToFirestore(newTxn)
      ]);
    } catch (err) {
      console.error('Failed to sync local transfer to Firestore:', err);
    }
  }
  queueTransactionEmail(txnId, status === 'completed' ? 'Your transfer has been completed.' : 'Your transfer is pending approval.');

  if (save_beneficiary && beneficiary_name) {
    const exists = db.prepare('SELECT id FROM beneficiaries WHERE user_id = ? AND account_number = ?').get(req.session.userId, to_account);
    if (!exists) {
      db.prepare(`
        INSERT INTO beneficiaries (user_id, name, account_number, bsb, bank_name, country, is_international)
        VALUES (?, ?, ?, ?, 'Australia', 'Australia', 0)
      `).run(req.session.userId, beneficiary_name || to_name, to_account, to_bsb || '');
    }
  }

  req.session.success = status === 'completed' 
    ? `Transfer of $${parseFloat(amount).toLocaleString('en-AU')} completed successfully!`
    : `Transfer of $${parseFloat(amount).toLocaleString('en-AU')} submitted for approval. You will be notified once processed.`;
  res.redirect('/transfers');
});

router.get('/international', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  const beneficiaries = db.prepare('SELECT * FROM beneficiaries WHERE user_id = ? AND is_international = 1').all(req.session.userId);
  const countries = require('../data/countries');
  const currencies = require('../data/currencies');
  const selectedAccountId = accounts.find(acc => String(acc.id) === String(req.query.from))?.id || accounts[0]?.id || null;
  const transferUser = getTransferUser(req.session.userId);

  res.render('transfers/international', {
    title: 'International Transfer - United Credit Bank',
    page: 'transfers',
    accounts,
    selectedAccountId,
    hasTransferPin: Boolean(transferUser && transferUser.transfer_pin_hash),
    beneficiaries,
    countries,
    currencies,
    rates: {
      AUD: 1,
      USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50,
      SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75
    },
    exchangeRates: {
      USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50,
      SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75
    }
  });
});

router.post('/international', requireAuth, requireVerified, async (req, res) => {
  const {
    from_account,
    to_name,
    swift_code,
    iban,
    country,
    currency,
    purpose,
    reference,
    save_beneficiary,
    beneficiary_name,
    transfer_pin
  } = req.body;
  const pinState = await validateTransferPin(req.session.userId, transfer_pin);
  if (!pinState.ok) {
    req.session.error = pinState.code === 'missing'
      ? 'Please create your transfer PIN in Settings before making transfers.'
      : pinState.code === 'required'
        ? 'Transfer PIN is required to authorise this transfer.'
        : 'Transfer PIN is incorrect.';
    return res.redirect(pinState.code === 'missing' ? '/user/settings' : '/transfers/international');
  }
  const exchangeRates = {
    AUD: 1,
    USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50,
    SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75
  };
  const to_account = req.body.to_account || req.body.iban || '';
  const amount = parseFloat(req.body.amount_aud || req.body.amount);
  const resolvedRate = parseFloat(req.body.exchange_rate) || exchangeRates[currency] || 1;
  const convertedAmount = parseFloat(req.body.amount_foreign) || (amount * resolvedRate);

  const sourceAccount = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(from_account, req.session.userId);
  if (!sourceAccount) {
    req.session.error = 'Invalid source account.';
    return res.redirect('/transfers/international');
  }

  const restrictionMessage = getAccountStatusMessage(sourceAccount, 'make international transfers');
  if (restrictionMessage) {
    req.session.error = restrictionMessage;
    return res.redirect('/transfers/international');
  }

  const fee = 25;
  const total = amount + fee;

  if (total > parseFloat(sourceAccount.available_balance)) {
    req.session.error = 'Insufficient funds. International transfers have a $25 fee.';
    return res.redirect('/transfers/international');
  }

  const status = 'pending';
  const holdAmount = total;
  const newAvailable = parseFloat(sourceAccount.available_balance) - holdAmount;
  db.prepare('UPDATE accounts SET available_balance = ? WHERE id = ?').run(newAvailable, from_account);

  const insertInfo = db.prepare(`
    INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, reference, recipient_name, recipient_account, swift_code, iban, country, status, fee, exchange_rate, converted_amount)
    VALUES (?, ?, 'international_transfer', ?, 'AUD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    from_account,
    req.session.userId,
    amount,
    purpose || 'International transfer',
    reference || '',
    to_name,
    to_account,
    swift_code || '',
    iban || '',
    country,
    status,
    fee,
    resolvedRate,
    convertedAmount
  );
  const txnId = insertInfo.lastInsertRowid;

  if (isFirestoreEnabled()) {
    try {
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(from_account);
      const newTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
      await Promise.all([
        syncAccountToFirestore(updatedAccount),
        syncTransactionToFirestore(newTxn)
      ]);
    } catch (err) {
      console.error('Failed to sync international transfer to Firestore:', err);
    }
  }
  queueTransactionEmail(txnId, 'Your international transfer request has been submitted.');

  if (save_beneficiary && beneficiary_name) {
    db.prepare(`
      INSERT INTO beneficiaries (user_id, name, account_number, swift_code, iban, country, is_international)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(req.session.userId, beneficiary_name || to_name, to_account, swift_code || '', iban || '', country);
  }

  addNotification(req.session.userId, 'International Transfer Pending', `AUD $${amount.toLocaleString()} transfer to ${to_name} (${country}) is awaiting approval`, 'warning');
  req.session.success = `International transfer of AUD $${amount.toLocaleString('en-AU')} submitted for approval.`;
  res.redirect('/transfers');
});

router.get('/history', requireAuth, (req, res) => {
  const { type, status, from_date, to_date } = req.query;

  let query = `
    SELECT t.*, a.account_name, a.account_number
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.user_id = ?
  `;
  const params = [req.session.userId];

  if (type && type !== 'all') {
    query += ` AND t.transaction_type = ?`;
    params.push(type);
  }
  if (status && status !== 'all') {
    query += ` AND t.status = ?`;
    params.push(status);
  }
  if (from_date) {
    query += ` AND DATE(t.created_at) >= ?`;
    params.push(from_date);
  }
  if (to_date) {
    query += ` AND DATE(t.created_at) <= ?`;
    params.push(to_date);
  }

  query += ` ORDER BY t.created_at DESC LIMIT 200`;
  const transactions = db.prepare(query).all(...params);

  res.render('transfers/history', {
    title: 'Transfer History - United Credit Bank',
    page: 'transfers',
    transactions,
    filters: req.query
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const transaction = db.prepare(`
    SELECT t.*, a.account_name, a.account_number, a.bsb as from_bsb
    FROM transactions t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.id = ? AND t.user_id = ?
  `).get(req.params.id, req.session.userId);

  if (!transaction) {
    req.session.error = 'Transaction not found.';
    return res.redirect('/transfers/history');
  }

  res.render('transfers/detail', {
    title: 'Transaction Details - United Credit Bank',
    page: 'transfers',
    transaction
  });
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!transaction || transaction.status !== 'pending') {
    req.session.error = 'Cannot cancel this transaction.';
    return res.redirect('/transfers/history');
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(transaction.account_id);
  const refund = parseFloat(transaction.amount) + parseFloat(transaction.fee);
  db.prepare('UPDATE accounts SET available_balance = available_balance + ? WHERE id = ?').run(refund, account.id);
  db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('cancelled', req.params.id);

  if (isFirestoreEnabled()) {
    try {
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
      const updatedTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
      await Promise.all([
        syncAccountToFirestore(updatedAccount),
        syncTransactionToFirestore(updatedTxn)
      ]);
    } catch (error) {
      console.error('Failed to sync cancelled transfer to Firestore:', error);
    }
  }

  addNotification(req.session.userId, 'Transfer Cancelled', `Transfer ${transaction.id} has been cancelled`, 'info');
  queueTransactionEmail(req.params.id, 'This transaction was cancelled.');
  req.session.success = 'Transfer cancelled successfully.';
  res.redirect(`/transfers/${req.params.id}`);
});

module.exports = router;
