'use strict';

const express = require('express');
const crypto = require('crypto');
const { requireAuth, requireVerified, getAccountStatusMessage } = require('../middleware/auth');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { toMinorUnits, fromMinorUnits } = require('../services/money');
const { sendTransactionActivityEmailById } = require('../services/email');

const router = express.Router();
const repo = createFirestoreRepository();
router.use(require('../middleware/production-financial-gate'));

function queueTransactionEmail(txnId, note) {
  if (!txnId) return;
  sendTransactionActivityEmailById(txnId, note ? { note } : {}).catch((error) => {
    console.error(`Failed to send transaction email for txn ${txnId}:`, error);
  });
}
function userId(req) { return String(req.session.userId); }
function amountMinor(doc, key = 'amount_minor') {
  if (Number.isSafeInteger(doc && doc[key])) return doc[key];
  // Legacy records are read-only compatible; all new writes use *_minor.
  if (doc && doc[key.replace('_minor', '')] !== undefined) return toMinorUnits(String(doc[key.replace('_minor', '')]));
  return 0;
}
function displayAmount(doc, key = 'amount_minor') { return fromMinorUnits(amountMinor(doc, key)); }
function accountForView(account) {
  if (!account) return account;
  return { ...account,
    balance: fromMinorUnits(Number.isSafeInteger(account.balance_minor) ? account.balance_minor : amountMinor({ amount: account.balance }, 'amount_minor')),
    available_balance: fromMinorUnits(Number.isSafeInteger(account.available_balance_minor) ? account.available_balance_minor : amountMinor({ amount: account.available_balance }, 'amount_minor'))
  };
}
function paymentForView(payment, account) {
  return { ...payment, amount: displayAmount(payment), account_name: account && account.account_name,
    account_number: account && account.account_number, customer_ref: payment.reference_number || '',
    scheduled_date: payment.payment_date || null, due_date: payment.payment_date || null };
}
function txnForView(txn) { return { ...txn, amount: displayAmount(txn) }; }
function newId() { return crypto.randomUUID(); }
async function userAccounts(uid, operableOnly = false) {
  const rows = await repo.list('accounts', [{ field: 'user_id', value: uid }]);
  return rows.filter(a => !operableOnly || !['frozen', 'closed', 'restricted'].includes(String(a.status || '').toLowerCase())).map(accountForView);
}
async function addNotice(uid, title, message, type) {
  await repo.create('notifications', { user_id: uid, title, message, type, read: false, created_at: new Date().toISOString() }, newId());
}
async function accountOwned(tx, accountId, uid) {
  if (!accountId || typeof accountId !== 'string') return null;
  const account = await tx.get('accounts', accountId);
  return account && account.user_id === uid ? account : null;
}
function balanceMinor(account, field) {
  const minorField = `${field}_minor`;
  if (Number.isSafeInteger(account[minorField])) return account[minorField];
  return toMinorUnits(String(account[field] ?? '0'));
}
function paymentStatusError(res, req, redirect, message) {
  req.session.error = message;
  return res.redirect(redirect);
}

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

router.get('/', requireAuth, requireVerified, async (req, res) => {
  try {
    const rows = await repo.list('bill_payments', [{ field: 'user_id', value: userId(req) }], { orderBy: { field: 'created_at', direction: 'desc' }, limit: 50 });
    const payments = await Promise.all(rows.map(async p => paymentForView(p, await repo.get('accounts', p.account_id))));
    const upcoming = payments.filter(p => p.status === 'scheduled' || p.status === 'pending');
    const completed = payments.filter(p => p.status === 'completed').slice(0, 20);
    res.render('billpay/index', { title: 'Bill Payments - United Credit Bank', page: 'billpay', payments, upcoming, completed, billers: BILLERS });
  } catch (error) { console.error('Bill payment list unavailable:', error); res.sendStatus(503); }
});

router.get('/pay', requireAuth, requireVerified, async (req, res) => {
  try {
    const accounts = await userAccounts(userId(req), true);
    const selectedBiller = req.query.biller ? BILLERS.find(b => b.code === req.query.biller) : null;
    res.render('billpay/pay', { title: 'Pay Bill - United Credit Bank', page: 'billpay', accounts, billers: BILLERS, selectedBiller });
  } catch (error) { console.error('Bill payment form unavailable:', error); res.sendStatus(503); }
});

router.post('/pay', requireAuth, requireVerified, async (req, res) => {
  const uid = userId(req); const { account_id, biller_name, biller_code, amount, recurring, frequency } = req.body;
  const reference_number = req.body.reference_number || req.body.customer_ref || '';
  const payment_date = req.body.payment_date || req.body.scheduled_date || null;
  try {
    const minor = toMinorUnits(amount);
    if (minor <= 0) return paymentStatusError(res, req, '/billpay/pay', 'Invalid amount or insufficient funds.');
    const paymentId = newId(); const txnId = newId(); const ledgerId = newId();
    const status = minor >= 300000 ? 'pending' : 'completed';
    await repo.runTransaction(async tx => {
      const account = await accountOwned(tx, String(account_id || ''), uid);
      if (!account) throw Object.assign(new Error('Invalid account selected.'), { userError: true });
      const restriction = getAccountStatusMessage(accountForView(account), 'pay bills');
      if (restriction) throw Object.assign(new Error(restriction), { userError: true });
      const available = balanceMinor(account, 'available_balance');
      if (minor > available) throw Object.assign(new Error('Invalid amount or insufficient funds.'), { userError: true });
      if (status === 'completed') {
        const balance = balanceMinor(account, 'balance');
        tx.update('accounts', account.id, { balance_minor: balance - minor, available_balance_minor: available - minor });
      }
      const now = new Date().toISOString();
      tx.create('bill_payments', paymentId, { user_id: uid, account_id: account.id, biller_name: String(biller_name || ''), biller_code: String(biller_code || ''), reference_number: String(reference_number), amount_minor: minor, currency: 'AUD', payment_date, recurring: Boolean(recurring), frequency: frequency || 'once', status, created_at: now });
      const txn = { user_id: uid, account_id: account.id, transaction_type: 'bill_payment', amount_minor: minor, currency: 'AUD', description: `Bill Payment: ${biller_name}`, reference: String(reference_number), status, created_at: now };
      tx.create('transactions', txnId, txn);
      tx.create('ledger_entries', ledgerId, { user_id: uid, account_id: account.id, transaction_id: txnId, entry_type: 'bill_payment', amount_minor: -minor, currency: 'AUD', status, created_at: now });
    });
    if (status === 'completed') { queueTransactionEmail(txnId, 'Your bill payment was processed successfully.'); await addNotice(uid, 'Bill Paid', `Payment of $${fromMinorUnits(minor).toLocaleString()} to ${biller_name} completed.`, 'success'); }
    else await addNotice(uid, 'Bill Payment Pending', `$${fromMinorUnits(minor).toLocaleString()} payment to ${biller_name} awaiting approval.`, 'warning');
    req.session.success = status === 'completed' ? `Bill payment of $${fromMinorUnits(minor).toLocaleString('en-AU')} to ${biller_name} completed successfully!` : `Bill payment of $${fromMinorUnits(minor).toLocaleString('en-AU')} has been submitted for approval.`;
    res.redirect('/billpay');
  } catch (error) { if (error.userError) return paymentStatusError(res, req, '/billpay/pay', error.message); console.error('Bill payment failed closed:', error); res.sendStatus(503); }
});

router.get('/scheduled', requireAuth, async (req, res) => {
  try {
    const all = await repo.list('bill_payments', [{ field: 'user_id', value: userId(req) }]);
    const rows = all.filter(p => p.status === 'scheduled' || p.recurring === true || p.recurring === 1).sort((a, b) => String(a.payment_date || '').localeCompare(String(b.payment_date || '')));
    const scheduled = await Promise.all(rows.map(async p => paymentForView(p, await repo.get('accounts', p.account_id))));
    res.render('billpay/scheduled', { title: 'Scheduled Payments - United Credit Bank', page: 'billpay', scheduled });
  } catch (error) { console.error('Scheduled payments unavailable:', error); res.sendStatus(503); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const payment = await repo.get('bill_payments', req.params.id);
    if (!payment || payment.user_id !== userId(req)) { req.session.error = 'Payment record not found.'; return res.redirect('/billpay'); }
    const viewPayment = paymentForView(payment, await repo.get('accounts', payment.account_id));
    res.render('billpay/detail', { title: 'Bill Payment Details - United Credit Bank', page: 'billpay', payment: viewPayment, bill: viewPayment });
  } catch (error) { console.error('Payment detail unavailable:', error); res.sendStatus(503); }
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    let payment;
    await repo.runTransaction(async tx => {
      payment = await tx.get('bill_payments', req.params.id);
      if (!payment || payment.user_id !== userId(req) || !['pending', 'scheduled'].includes(payment.status)) throw Object.assign(new Error('Cannot cancel this payment.'), { userError: true });
      tx.update('bill_payments', payment.id, { status: 'cancelled', updated_at: new Date().toISOString() });
    });
    await addNotice(userId(req), 'Payment Cancelled', `Bill payment #${payment.id} has been cancelled.`, 'info');
    req.session.success = 'Payment cancelled successfully.'; res.redirect(`/billpay/${req.params.id}`);
  } catch (error) { if (error.userError) return paymentStatusError(res, req, '/billpay', error.message); console.error('Payment cancellation failed closed:', error); res.sendStatus(503); }
});

router.get('/deposit/new', requireAuth, requireVerified, async (req, res) => {
  try { const accounts = await userAccounts(userId(req), true); res.render('billpay/deposit', { title: 'Deposit Funds - United Credit Bank', page: 'billpay', accounts }); }
  catch (error) { console.error('Deposit form unavailable:', error); res.sendStatus(503); }
});
router.post('/deposit', requireAuth, requireVerified, async (req, res) => {
  const uid = userId(req); const { account_id, amount, source, reference, description } = req.body;
  try {
    const minor = toMinorUnits(amount); if (minor <= 0) return paymentStatusError(res, req, '/billpay/deposit/new', 'Invalid deposit amount.');
    const txnId = newId(); const ledgerId = newId(); const status = minor >= 1000000 ? 'pending' : 'completed'; let accountName = '';
    await repo.runTransaction(async tx => {
      const account = await accountOwned(tx, String(account_id || ''), uid);
      if (!account) throw Object.assign(new Error('Invalid account.'), { userError: true });
      const restriction = getAccountStatusMessage(accountForView(account), 'receive deposits');
      if (restriction) throw Object.assign(new Error(restriction), { userError: true });
      accountName = account.account_name || '';
      const now = new Date().toISOString();
      if (status === 'completed') tx.update('accounts', account.id, { balance_minor: balanceMinor(account, 'balance') + minor, available_balance_minor: balanceMinor(account, 'available_balance') + minor });
      tx.create('transactions', txnId, { user_id: uid, account_id: account.id, transaction_type: 'deposit', amount_minor: minor, currency: 'AUD', description: description || `Deposit from ${source || 'Bank Transfer'}`, reference: reference || '', status, created_at: now });
      tx.create('ledger_entries', ledgerId, { user_id: uid, account_id: account.id, transaction_id: txnId, entry_type: 'deposit', amount_minor: minor, currency: 'AUD', status, created_at: now });
    });
    await addNotice(uid, status === 'completed' ? 'Deposit Successful' : 'Deposit Pending', status === 'completed' ? `$${fromMinorUnits(minor).toLocaleString()} deposited to ${accountName}.` : `Deposit of $${fromMinorUnits(minor).toLocaleString()} awaiting admin approval.`, status === 'completed' ? 'success' : 'warning');
    queueTransactionEmail(txnId, status === 'completed' ? 'A credit has been applied to your account.' : 'Your deposit is pending approval.');
    req.session.success = status === 'completed' ? `Successfully deposited $${fromMinorUnits(minor).toLocaleString('en-AU')}!` : `Deposit of $${fromMinorUnits(minor).toLocaleString('en-AU')} submitted for approval.`; res.redirect('/user/dashboard');
  } catch (error) { if (error.userError) return paymentStatusError(res, req, '/billpay/deposit/new', error.message); console.error('Deposit failed closed:', error); res.sendStatus(503); }
});

router.get('/withdraw/new', requireAuth, requireVerified, async (req, res) => {
  try { const accounts = await userAccounts(userId(req), true); res.render('billpay/withdraw', { title: 'Withdraw Funds - United Credit Bank', page: 'billpay', accounts }); }
  catch (error) { console.error('Withdrawal form unavailable:', error); res.sendStatus(503); }
});
router.post('/withdraw', requireAuth, requireVerified, async (req, res) => {
  const uid = userId(req); const { account_id, amount, method, destination, reference, description } = req.body;
  try {
    const minor = toMinorUnits(amount); if (minor <= 0) return paymentStatusError(res, req, '/billpay/withdraw/new', 'Invalid withdrawal amount.');
    const txnId = newId(); const ledgerId = newId(); const status = minor >= 500000 ? 'pending' : 'completed'; let accountName = '';
    await repo.runTransaction(async tx => {
      const account = await accountOwned(tx, String(account_id || ''), uid);
      if (!account) throw Object.assign(new Error('Invalid account.'), { userError: true });
      const restriction = getAccountStatusMessage(accountForView(account), 'withdraw funds');
      if (restriction) throw Object.assign(new Error(restriction), { userError: true });
      const available = balanceMinor(account, 'available_balance'); if (minor > available) throw Object.assign(new Error('Insufficient funds.'), { userError: true });
      accountName = account.account_name || ''; const now = new Date().toISOString();
      tx.update('accounts', account.id, { ...(status === 'completed' ? { balance_minor: balanceMinor(account, 'balance') - minor } : {}), available_balance_minor: available - minor });
      tx.create('transactions', txnId, { user_id: uid, account_id: account.id, transaction_type: 'withdrawal', amount_minor: minor, currency: 'AUD', description: description || `Withdrawal via ${method}`, reference: reference || '', recipient_name: destination || '', status, created_at: now });
      tx.create('ledger_entries', ledgerId, { user_id: uid, account_id: account.id, transaction_id: txnId, entry_type: 'withdrawal', amount_minor: -minor, currency: 'AUD', status, created_at: now });
    });
    await addNotice(uid, status === 'completed' ? 'Withdrawal Complete' : 'Withdrawal Pending', status === 'completed' ? `$${fromMinorUnits(minor).toLocaleString()} withdrawn from ${accountName}.` : `Withdrawal of $${fromMinorUnits(minor).toLocaleString()} awaiting admin approval.`, status === 'completed' ? 'info' : 'warning');
    queueTransactionEmail(txnId, status === 'completed' ? 'A debit has been applied to your account.' : 'Your withdrawal is pending approval.');
    req.session.success = status === 'completed' ? `Withdrawal of $${fromMinorUnits(minor).toLocaleString('en-AU')} completed!` : `Withdrawal of $${fromMinorUnits(minor).toLocaleString('en-AU')} submitted for approval.`; res.redirect('/user/dashboard');
  } catch (error) { if (error.userError) return paymentStatusError(res, req, '/billpay/withdraw/new', error.message); console.error('Withdrawal failed closed:', error); res.sendStatus(503); }
});

module.exports = router;
