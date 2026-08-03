const express = require('express');
const { db } = require('../database');
const {
  requireAuth,
  requireVerified,
  getUserAccounts,
  getAccountStatusMessage,
  addNotification
} = require('../middleware/auth');

const router = express.Router();

const BILLERS = [
  { code: 'TELSTRA', name: 'Telstra', category: 'Telecommunications', icon: '📱' },
  { code: 'OPTUS', name: 'Optus', category: 'Telecommunications', icon: '📶' },
  { code: 'VODAFONE', name: 'Vodafone AU', category: 'Telecommunications', icon: '📡' },
  { code: 'AGL', name: 'AGL Energy', category: 'Utilities - Electricity/Gas', icon: '⚡' },
  { code: 'ORIGIN', name: 'Origin Energy', category: 'Utilities - Electricity/Gas', icon: '🔌' },
  { code: 'ENERGYAUS', name: 'EnergyAustralia', category: 'Utilities - Electricity/Gas', icon: '💡' },
  { code: 'SYDWATER', name: 'Sydney Water', category: 'Utilities - Water', icon: '💧' },
  { code: 'MELBWATER', name: 'Melbourne Water', category: 'Utilities - Water', icon: '🚿' },
  { code: 'COUNCIL', name: 'Local Council Rates', category: 'Government', icon: '🏛️' },
  { code: 'ATO', name: 'Australian Taxation Office', category: 'Government - Tax', icon: '📋' },
  { code: 'NSWFINES', name: 'Revenue NSW - Fines', category: 'Government - Fines', icon: '⚖️' },
  { code: 'VICFINES', name: 'Victoria Fines', category: 'Government - Fines', icon: '⚖️' },
  { code: 'RMS', name: 'Transport for NSW (RMS)', category: 'Government - Transport', icon: '🚗' },
  { code: 'VICROADS', name: 'VicRoads', category: 'Government - Transport', icon: '🚙' },
  { code: 'FOXTEL', name: 'Foxtel', category: 'Entertainment', icon: '📺' },
  { code: 'NETFLIX', name: 'Netflix', category: 'Entertainment - Streaming', icon: '🎬' },
  { code: 'SPOTIFY', name: 'Spotify', category: 'Entertainment - Music', icon: '🎵' },
  { code: 'COLES', name: 'Coles Online', category: 'Retail - Grocery', icon: '🛒' },
  { code: 'WOOLWORTHS', name: 'Woolworths', category: 'Retail - Grocery', icon: '🛍️' },
  { code: 'INSURANCE', name: 'Insurance Premiums', category: 'Insurance', icon: '🛡️' },
  { code: 'MEDIBANK', name: 'Medibank Private', category: 'Health Insurance', icon: '🏥' },
  { code: 'BUPA', name: 'Bupa Australia', category: 'Health Insurance', icon: '❤️' },
  { code: 'SCHOOL', name: 'School Fees', category: 'Education', icon: '🎓' },
  { code: 'UNI', name: 'University Fees (HECS)', category: 'Education', icon: '📚' },
  { code: 'CARREG', name: 'Car Registration', category: 'Government - Transport', icon: '🚘' },
  { code: 'LANDLORD', name: 'Rent / Body Corporate', category: 'Housing', icon: '🏠' },
  { code: 'STRATA', name: 'Strata Fees', category: 'Housing', icon: '🏢' }
];

router.get('/', requireAuth, requireVerified, (req, res) => {
  const payments = db.prepare(`
    SELECT bp.*, a.account_name,
      bp.reference_number as customer_ref,
      bp.payment_date as scheduled_date,
      bp.payment_date as due_date
    FROM bill_payments bp
    JOIN accounts a ON bp.account_id = a.id
    WHERE bp.user_id = ?
    ORDER BY bp.created_at DESC
    LIMIT 50
  `).all(req.session.userId);

  const upcoming = payments.filter(p => p.status === 'scheduled' || p.status === 'pending');
  const completed = payments.filter(p => p.status === 'completed').slice(0, 20);

  res.render('billpay/index', {
    title: 'Bill Payments - United Credit Bank',
    page: 'billpay',
    payments,
    upcoming,
    completed,
    billers: BILLERS
  });
});

router.get('/pay', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  const selectedBiller = req.query.biller ? BILLERS.find(b => b.code === req.query.biller) : null;

  res.render('billpay/pay', {
    title: 'Pay Bill - United Credit Bank',
    page: 'billpay',
    accounts,
    billers: BILLERS,
    selectedBiller
  });
});

router.post('/pay', requireAuth, requireVerified, (req, res) => {
  const {
    account_id,
    biller_name,
    biller_code,
    amount,
    recurring,
    frequency
  } = req.body;
  const reference_number = req.body.reference_number || req.body.customer_ref;
  const payment_date = req.body.payment_date || req.body.scheduled_date || null;

  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.session.userId);
  if (!account) {
    req.session.error = 'Invalid account selected.';
    return res.redirect('/billpay/pay');
  }

  const restrictionMessage = getAccountStatusMessage(account, 'pay bills');
  if (restrictionMessage) {
    req.session.error = restrictionMessage;
    return res.redirect('/billpay/pay');
  }

  const payAmount = parseFloat(amount);
  if (payAmount <= 0 || payAmount > parseFloat(account.available_balance)) {
    req.session.error = 'Invalid amount or insufficient funds.';
    return res.redirect('/billpay/pay');
  }

  const needsApproval = payAmount >= 3000;
  const status = needsApproval ? 'pending' : 'completed';

  if (!needsApproval) {
    const newBalance = parseFloat(account.balance) - payAmount;
    const newAvailable = parseFloat(account.available_balance) - payAmount;
    db.prepare('UPDATE accounts SET balance = ?, available_balance = ? WHERE id = ?').run(newBalance, newAvailable, account_id);
  }

  const insert = db.prepare(`
    INSERT INTO bill_payments (user_id, account_id, biller_name, biller_code, reference_number, amount, currency, payment_date, recurring, frequency, status)
    VALUES (?, ?, ?, ?, ?, ?, 'AUD', ?, ?, ?, ?)
  `);
  insert.run(
    req.session.userId,
    account_id,
    biller_name,
    biller_code || '',
    reference_number,
    payAmount,
    payment_date || null,
    recurring ? 1 : 0,
    frequency || 'once',
    status
  );

  const bpId = insert.lastInsertRowid;

  if (status === 'completed') {
    const txnInsert = db.prepare(`
      INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, reference, status)
      VALUES (?, ?, 'bill_payment', ?, 'AUD', ?, ?, 'completed')
    `);
    txnInsert.run(account_id, req.session.userId, payAmount, `Bill Payment: ${biller_name}`, reference_number);
    addNotification(req.session.userId, 'Bill Paid', `Payment of $${payAmount.toLocaleString()} to ${biller_name} completed.`, 'success');
  } else {
    addNotification(req.session.userId, 'Bill Payment Pending', `$${payAmount.toLocaleString()} payment to ${biller_name} awaiting approval.`, 'warning');
  }

  req.session.success = status === 'completed' 
    ? `Bill payment of $${payAmount.toLocaleString('en-AU')} to ${biller_name} completed successfully!`
    : `Bill payment of $${payAmount.toLocaleString('en-AU')} has been submitted for approval.`;
  res.redirect('/billpay');
});

router.get('/scheduled', requireAuth, (req, res) => {
  const scheduled = db.prepare(`
    SELECT bp.*, a.account_name,
      bp.reference_number as customer_ref,
      bp.payment_date as scheduled_date,
      bp.payment_date as due_date
    FROM bill_payments bp
    JOIN accounts a ON bp.account_id = a.id
    WHERE bp.user_id = ? AND (bp.status = 'scheduled' OR bp.recurring = 1)
    ORDER BY bp.payment_date
  `).all(req.session.userId);

  res.render('billpay/scheduled', {
    title: 'Scheduled Payments - United Credit Bank',
    page: 'billpay',
    scheduled
  });
});

router.get('/:id', requireAuth, (req, res) => {
  const payment = db.prepare(`
    SELECT bp.*, a.account_name, a.account_number,
      bp.reference_number as customer_ref,
      bp.payment_date as scheduled_date,
      bp.payment_date as due_date
    FROM bill_payments bp
    JOIN accounts a ON bp.account_id = a.id
    WHERE bp.id = ? AND bp.user_id = ?
  `).get(req.params.id, req.session.userId);

  if (!payment) {
    req.session.error = 'Payment record not found.';
    return res.redirect('/billpay');
  }

  res.render('billpay/detail', {
    title: 'Bill Payment Details - United Credit Bank',
    page: 'billpay',
    payment,
    bill: payment
  });
});

router.post('/:id/cancel', requireAuth, (req, res) => {
  const payment = db.prepare('SELECT * FROM bill_payments WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!payment || !['pending', 'scheduled'].includes(payment.status)) {
    req.session.error = 'Cannot cancel this payment.';
    return res.redirect('/billpay');
  }

  if (payment.status === 'pending') {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(payment.account_id);
    db.prepare('UPDATE accounts SET available_balance = available_balance + ? WHERE id = ?').run(payment.amount, account.id);
  }

  db.prepare('UPDATE bill_payments SET status = ? WHERE id = ?').run('cancelled', req.params.id);
  addNotification(req.session.userId, 'Payment Cancelled', `Bill payment #${payment.id} has been cancelled.`, 'info');
  req.session.success = 'Payment cancelled successfully.';
  res.redirect(`/billpay/${req.params.id}`);
});

router.get('/deposit/new', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  res.render('billpay/deposit', {
    title: 'Deposit Funds - United Credit Bank',
    page: 'billpay',
    accounts
  });
});

router.post('/deposit', requireAuth, requireVerified, (req, res) => {
  const { account_id, amount, source, reference, description } = req.body;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.session.userId);
  if (!account) {
    req.session.error = 'Invalid account.';
    return res.redirect('/billpay/deposit/new');
  }

  const depositRestriction = getAccountStatusMessage(account, 'receive deposits');
  if (depositRestriction) {
    req.session.error = depositRestriction;
    return res.redirect('/billpay/deposit/new');
  }

  const depositAmount = parseFloat(amount);
  const needsApproval = depositAmount >= 10000;
  const status = needsApproval ? 'pending' : 'completed';

  const insert = db.prepare(`
    INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, reference, status)
    VALUES (?, ?, 'deposit', ?, 'AUD', ?, ?, ?)
  `);
  insert.run(account_id, req.session.userId, depositAmount, description || `Deposit from ${source || 'Bank Transfer'}`, reference || '', status);

  if (status === 'completed') {
    db.prepare('UPDATE accounts SET balance = balance + ?, available_balance = available_balance + ? WHERE id = ?')
      .run(depositAmount, depositAmount, account_id);
    addNotification(req.session.userId, 'Deposit Successful', `$${depositAmount.toLocaleString()} deposited to ${account.account_name}.`, 'success');
  } else {
    addNotification(req.session.userId, 'Deposit Pending', `Deposit of $${depositAmount.toLocaleString()} awaiting admin approval.`, 'warning');
  }

  req.session.success = status === 'completed'
    ? `Successfully deposited $${depositAmount.toLocaleString('en-AU')}!`
    : `Deposit of $${depositAmount.toLocaleString('en-AU')} submitted for approval.`;
  res.redirect('/user/dashboard');
});

router.get('/withdraw/new', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  res.render('billpay/withdraw', {
    title: 'Withdraw Funds - United Credit Bank',
    page: 'billpay',
    accounts
  });
});

router.post('/withdraw', requireAuth, requireVerified, (req, res) => {
  const { account_id, amount, method, destination, reference, description } = req.body;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.session.userId);
  if (!account) {
    req.session.error = 'Invalid account.';
    return res.redirect('/billpay/withdraw/new');
  }

  const withdrawRestriction = getAccountStatusMessage(account, 'withdraw funds');
  if (withdrawRestriction) {
    req.session.error = withdrawRestriction;
    return res.redirect('/billpay/withdraw/new');
  }

  const withdrawAmount = parseFloat(amount);
  if (withdrawAmount > parseFloat(account.available_balance)) {
    req.session.error = 'Insufficient funds.';
    return res.redirect('/billpay/withdraw/new');
  }

  const needsApproval = withdrawAmount >= 5000;
  const status = needsApproval ? 'pending' : 'completed';

  if (status === 'completed') {
    db.prepare('UPDATE accounts SET balance = balance - ?, available_balance = available_balance - ? WHERE id = ?')
      .run(withdrawAmount, withdrawAmount, account_id);
  } else {
    db.prepare('UPDATE accounts SET available_balance = available_balance - ? WHERE id = ?').run(withdrawAmount, account_id);
  }

  const insert = db.prepare(`
    INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, reference, recipient_name, status)
    VALUES (?, ?, 'withdrawal', ?, 'AUD', ?, ?, ?, ?)
  `);
  insert.run(account_id, req.session.userId, withdrawAmount, description || `Withdrawal via ${method}`, reference || '', destination || '', status);

  if (status === 'completed') {
    addNotification(req.session.userId, 'Withdrawal Complete', `$${withdrawAmount.toLocaleString()} withdrawn from ${account.account_name}.`, 'info');
  } else {
    addNotification(req.session.userId, 'Withdrawal Pending', `Withdrawal of $${withdrawAmount.toLocaleString()} awaiting approval.`, 'warning');
  }

  req.session.success = status === 'completed'
    ? `Withdrawal of $${withdrawAmount.toLocaleString('en-AU')} completed!`
    : `Withdrawal of $${withdrawAmount.toLocaleString('en-AU')} submitted for approval.`;
  res.redirect('/user/dashboard');
});

module.exports = router;
