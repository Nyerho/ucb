'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { toMinorUnits, fromMinorUnits } = require('../services/money');
const {
  requireAuth,
  requireVerified,
  getUserAccounts,
  getAccountStatusMessage,
  addNotification
} = require('../middleware/auth');
const { sendTransactionActivityEmailById } = require('../services/email');

const router = express.Router();
const repo = createFirestoreRepository();
router.use(require('../middleware/production-financial-gate'));

function uid(req) { return String(req.auth.uid); }
function queueTransactionEmail(txnId, note) {
  if (!txnId) return;
  sendTransactionActivityEmailById(txnId, note ? { note } : {}).catch((error) => {
    console.error(`Failed to send transaction email for txn ${txnId}:`, error);
  });
}
function legacyMinor(record, minorField, legacyField) {
  if (Number.isSafeInteger(record && record[minorField])) return record[minorField];
  if (record && record[legacyField] !== undefined && record[legacyField] !== null) return toMinorUnits(String(record[legacyField]));
  return 0;
}
function loanForView(loan, account) {
  const principalMinor = legacyMinor(loan, 'loan_amount_minor', 'loan_amount');
  const monthlyMinor = legacyMinor(loan, 'monthly_repayment_minor', 'monthly_repayment');
  const totalMinor = legacyMinor(loan, 'total_repayment_minor', 'total_repayment');
  const remainingMinor = loan.remaining_balance_minor !== undefined
    ? legacyMinor(loan, 'remaining_balance_minor', 'remaining_balance') : principalMinor;
  return {
    ...loan,
    principal_amount: fromMinorUnits(principalMinor),
    loan_amount: fromMinorUnits(principalMinor),
    monthly_payment: fromMinorUnits(monthlyMinor),
    monthly_repayment: fromMinorUnits(monthlyMinor),
    total_amount: fromMinorUnits(totalMinor),
    total_repayment: fromMinorUnits(totalMinor),
    term_months: loan.loan_term_months ?? loan.term_months,
    amount_paid: fromMinorUnits(Math.max(0, totalMinor - remainingMinor)),
    remaining_balance: fromMinorUnits(remainingMinor),
    disbursement_account: account && account.account_name,
    account_name: account && account.account_name,
    account_number: account && account.account_number
  };
}
function accountForView(account) {
  if (!account) return account;
  return {
    ...account,
    balance: fromMinorUnits(legacyMinor(account, 'balance_minor', 'balance')),
    available_balance: fromMinorUnits(account.available_balance_minor !== undefined
      ? legacyMinor(account, 'available_balance_minor', 'available_balance')
      : legacyMinor(account, 'balance_minor', 'balance'))
  };
}
function paymentForView(payment) {
  const amountMinor = legacyMinor(payment, 'amount_minor', 'amount');
  return { ...payment, amount: fromMinorUnits(amountMinor), paid_at: payment.payment_date || payment.created_at, created_at: payment.created_at || payment.payment_date };
}

const LOAN_TYPES = [
  { type: 'Personal Loan', name: 'Personal Loan', rate_min: 6.99, rate_max: 19.99, min: 2000, max: 50000, term_min: 12, term_max: 84, features: ['Flexible loan amounts', 'No early repayment fees', 'Quick approval', 'Funds in 24hrs'], icon: '💰' },
  { type: 'Home Loan', name: 'Home Loan / Mortgage', rate_min: 5.49, rate_max: 7.99, min: 50000, max: 2000000, term_min: 120, term_max: 360, features: ['Competitive variable rates', 'Offset account option', 'Redraw facility', 'Split loan available'], icon: '🏠' },
  { type: 'Car Loan', name: 'Car Loan', rate_min: 4.99, rate_max: 14.99, min: 5000, max: 150000, term_min: 12, term_max: 84, features: ['Secured & unsecured options', 'Pre-approval available', 'Flexible terms', 'Novated leasing'], icon: '🚗' },
  { type: 'Business Loan', name: 'Business Loan', rate_min: 7.49, rate_max: 22.99, min: 10000, max: 1000000, term_min: 12, term_max: 120, features: ['Equipment finance', 'Working capital', 'Invoice financing', 'Business overdraft'], icon: '🏢' },
  { type: 'Education Loan', name: 'Education / Student Loan', rate_min: 3.99, rate_max: 9.99, min: 1000, max: 100000, term_min: 12, term_max: 120, features: ['Study now, pay later', 'Flexible repayment', 'Interest only during study', 'Co-signer option'], icon: '🎓' },
  { type: 'Line of Credit', name: 'Line of Credit', rate_min: 8.99, rate_max: 18.99, min: 5000, max: 250000, term_min: 12, term_max: 240, features: ['Revolving credit', 'Use what you need', 'Interest only on usage', 'Flexible repayments'], icon: '💳' }
];
function buildLoanTypeViewModel(loanType) {
  return {
    ...loanType,
    rate: `${loanType.rate_min.toFixed(2)}% - ${loanType.rate_max.toFixed(2)}%`,
    rate_val: ((loanType.rate_min + loanType.rate_max) / 2).toFixed(2),
    min_val: loanType.min,
    max_val: loanType.max,
    default_term: Math.min(loanType.term_max, Math.max(loanType.term_min, 36)),
    term: `${loanType.term_min} - ${loanType.term_max} months`,
    desc: loanType.features.slice(0, 2).join(' • ')
  };
}
function calculateEMI(principal, annualRate, months) {
  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return principal / months;
  return principal * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1);
}
function failClosed(error, res, message = 'Loan services are temporarily unavailable. Please try again.') {
  console.error('Loan Firestore operation failed:', error && error.message);
  return res.status(503).send(message);
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const loans = await repo.list('loans', [{ field: 'user_id', value: uid(req) }], { orderBy: { field: 'requested_at', direction: 'DESCENDING' }, limit: 100 });
    const viewLoans = await Promise.all(loans.map(async (loan) => {
      const [account, payments] = await Promise.all([
        loan.account_id ? repo.get('accounts', String(loan.account_id)) : null,
        repo.list('loan_payments', [{ field: 'loan_id', value: String(loan.id) }], { orderBy: { field: 'payment_date', direction: 'DESCENDING' }, limit: 250 })
      ]);
      return { ...loanForView(loan, account), payments: payments.map(paymentForView), status: loan.status === 'disbursed' ? 'active' : loan.status };
    }));
    return res.render('loans/index', { title: 'My Loans - United Credit Bank', page: 'loans', loans: viewLoans, loanTypes: LOAN_TYPES.map(buildLoanTypeViewModel) });
  } catch (error) { return failClosed(error, res); }
});

router.get('/apply/new', requireAuth, (req, res) => {
  const query = req.query.type ? `?type=${encodeURIComponent(req.query.type)}` : '';
  res.redirect(`/loans/apply${query}`);
});

router.get('/apply', requireAuth, requireVerified, async (req, res) => {
  try {
    const uidValue = uid(req);
    const [accounts, kyc, user] = await Promise.all([
      getUserAccounts(uidValue, { operableOnly: true }),
      repo.list('kyc', [{ field: 'user_id', value: uidValue }, { field: 'status', value: 'approved' }], { limit: 1 }),
      Promise.resolve(req.user || null)
    ]);
    const loanTypes = LOAN_TYPES.map(buildLoanTypeViewModel);
    const selectedLoanType = loanTypes.find((loan) => loan.type === req.query.type)?.type || loanTypes[0]?.type || null;
    return res.render('loans/apply', { title: 'Apply for Loan - United Credit Bank', page: 'loans', accounts: accounts.map(accountForView), loanTypes, selectedLoanType, isVerified: !!kyc.length, calculateEMI, user });
  } catch (error) { return failClosed(error, res); }
});

router.post('/calculate', requireAuth, (req, res) => {
  try {
    const principalMinor = toMinorUnits(req.body.amount);
    const rate = Number(req.body.rate);
    const term = Number(req.body.term);
    if (principalMinor <= 0 || !Number.isFinite(rate) || rate < 0 || !Number.isInteger(term) || term < 1 || term > 600) return res.status(400).json({ error: 'Invalid loan calculation inputs.' });
    const amount = fromMinorUnits(principalMinor);
    const emiMinor = toMinorUnits(calculateEMI(amount, rate, term).toFixed(2));
    const totalMinor = emiMinor * term;
    return res.json({ emi: fromMinorUnits(emiMinor).toFixed(2), total: fromMinorUnits(totalMinor).toFixed(2), interest: fromMinorUnits(totalMinor - principalMinor).toFixed(2) });
  } catch (_) { return res.status(400).json({ error: 'Enter valid loan calculation inputs.' }); }
});

router.post('/apply', requireAuth, requireVerified, async (req, res) => {
  const loanType = LOAN_TYPES.find((type) => type.type === req.body.loan_type);
  if (!loanType) { req.session.error = 'Invalid loan type.'; return res.redirect('/loans/apply'); }
  try {
    const amountMinor = toMinorUnits(req.body.loan_amount || req.body.principal_amount);
    const rate = Number(req.body.interest_rate || ((loanType.rate_min + loanType.rate_max) / 2).toFixed(2));
    const term = Number(req.body.loan_term_months || req.body.term_months);
    if (amountMinor <= 0 || !Number.isFinite(rate) || rate <= 0 || !Number.isInteger(term) || term < loanType.term_min || term > loanType.term_max) throw new TypeError('Invalid loan application values.');
    const accountId = req.body.account_id ? String(req.body.account_id) : null;
    if (accountId) {
      const account = await repo.get('accounts', accountId);
      if (!account || String(account.user_id) !== uid(req)) throw new TypeError('Invalid account selected.');
    }
    const emiMinor = toMinorUnits(calculateEMI(fromMinorUnits(amountMinor), rate, term).toFixed(2));
    const totalMinor = emiMinor * term;
    const annualIncomeMinor = req.body.annual_income ? toMinorUnits(req.body.annual_income) : 0;
    if (annualIncomeMinor < 0) throw new TypeError('Invalid annual income.');
    const now = new Date().toISOString();
    await repo.create('loans', {
      user_id: uid(req), account_id: accountId, loan_type: loanType.type,
      loan_amount_minor: amountMinor, interest_rate: rate, loan_term_months: term,
      monthly_repayment_minor: emiMinor, total_repayment_minor: totalMinor,
      purpose: String(req.body.purpose || ''), employment_status: String(req.body.employment_status || ''),
      annual_income_minor: annualIncomeMinor, remaining_balance_minor: amountMinor,
      status: 'pending', requested_at: now, created_at: now, updated_at: now
    }, crypto.randomUUID());
    await addNotification(uid(req), 'Loan Application Submitted', `Your ${loanType.name} application for $${fromMinorUnits(amountMinor).toLocaleString()} is being reviewed.`, 'info');
    req.session.success = `Your ${loanType.name} application has been submitted! We will contact you within 48 hours.`;
    return res.redirect('/loans');
  } catch (error) {
    console.error('Loan application failed closed:', error && error.message);
    if (error instanceof TypeError || error instanceof RangeError) { req.session.error = 'Enter valid loan application details.'; return res.redirect('/loans/apply'); }
    return res.sendStatus(503);
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const loan = await repo.get('loans', String(req.params.id));
    if (!loan || String(loan.user_id) !== uid(req)) { req.session.error = 'Loan not found.'; return res.redirect('/loans'); }
    const [account, rawPayments, accounts] = await Promise.all([
      loan.account_id ? repo.get('accounts', String(loan.account_id)) : null,
      repo.list('loan_payments', [{ field: 'loan_id', value: String(loan.id) }], { orderBy: { field: 'payment_date', direction: 'DESCENDING' }, limit: 250 }),
      getUserAccounts(uid(req))
    ]);
    const viewLoan = loanForView(loan, account);
    if (viewLoan.status === 'disbursed') viewLoan.status = 'active';
    return res.render('loans/detail', { title: `${loan.loan_type} Details - United Credit Bank`, page: 'loans', loan: viewLoan, payments: rawPayments.map(paymentForView), calculateEMI, accounts: accounts.map(accountForView) });
  } catch (error) { return failClosed(error, res); }
});

router.post('/:id/payment', requireAuth, async (req, res) => {
  const uidValue = uid(req);
  const loanId = String(req.params.id);
  const accountId = String(req.body.from_account || req.body.account_id || '');
  let txnId;
  try {
    const amountMinor = toMinorUnits(req.body.amount);
    if (amountMinor <= 0 || !accountId) { req.session.error = 'Enter a valid payment amount and account.'; return res.redirect(`/loans/${loanId}`); }
    txnId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    const now = new Date().toISOString();
    let loanType = '';
    await repo.runTransaction(async (tx) => {
      const [loan, account] = await Promise.all([tx.get('loans', loanId), tx.get('accounts', accountId)]);
      if (!loan || String(loan.user_id) !== uidValue || !['disbursed', 'active'].includes(String(loan.status))) throw Object.assign(new Error('Cannot make payment on this loan.'), { userError: true });
      if (!account || String(account.user_id) !== uidValue) throw Object.assign(new Error('Invalid account selected.'), { userError: true });
      const restriction = getAccountStatusMessage(accountForView(account), 'make loan repayments');
      if (restriction) throw Object.assign(new Error(restriction), { userError: true });
      const availableMinor = legacyMinor(account, 'available_balance_minor', 'available_balance');
      const balanceMinor = legacyMinor(account, 'balance_minor', 'balance');
      const remainingMinor = loan.remaining_balance_minor !== undefined ? legacyMinor(loan, 'remaining_balance_minor', 'remaining_balance') : legacyMinor(loan, 'loan_amount_minor', 'loan_amount');
      if (amountMinor > availableMinor) throw Object.assign(new Error('Insufficient funds.'), { userError: true });
      if (amountMinor > remainingMinor) throw Object.assign(new Error('Payment exceeds the remaining loan balance.'), { userError: true });
      loanType = String(loan.loan_type || 'Loan');
      tx.update('accounts', accountId, { balance_minor: balanceMinor - amountMinor, available_balance_minor: availableMinor - amountMinor, updated_at: now });
      tx.update('loans', loanId, { remaining_balance_minor: remainingMinor - amountMinor, updated_at: now });
      tx.create('loan_payments', paymentId, { user_id: uidValue, loan_id: loanId, account_id: accountId, amount_minor: amountMinor, payment_method: String(req.body.payment_method || 'bank_transfer'), status: 'completed', payment_date: now, created_at: now });
      tx.create('transactions', txnId, { user_id: uidValue, account_id: accountId, transaction_type: 'loan_payment', amount_minor: amountMinor, currency: 'AUD', description: `${loanType} Repayment - Loan #${loanId}`, status: 'completed', created_at: now });
      tx.create('ledger_entries', ledgerId, { user_id: uidValue, account_id: accountId, transaction_id: txnId, entry_type: 'loan_payment', amount_minor: -amountMinor, balance_after_minor: balanceMinor - amountMinor, currency: 'AUD', status: 'completed', reference_id: loanId, created_at: now });
    });
    await addNotification(uidValue, 'Loan Payment Made', `Payment of $${fromMinorUnits(amountMinor).toLocaleString()} made to ${loanType}.`, 'success');
    queueTransactionEmail(txnId, 'Your loan repayment was applied successfully.');
    req.session.success = 'Payment successful!';
    return res.redirect(`/loans/${loanId}`);
  } catch (error) {
    if (error.userError) { req.session.error = error.message; return res.redirect(`/loans/${loanId}`); }
    if (error instanceof TypeError || error instanceof RangeError) { req.session.error = 'Enter a valid payment amount.'; return res.redirect(`/loans/${loanId}`); }
    console.error('Loan payment failed closed:', error && error.message);
    return res.sendStatus(503);
  }
});

router.post('/:id/pay', requireAuth, (req, res) => res.redirect(307, `/loans/${req.params.id}/payment`));

module.exports = router;
