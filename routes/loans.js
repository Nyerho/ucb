const express = require('express');
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

function queueTransactionEmail(txnId, note) {
  if (!txnId) return;
  sendTransactionActivityEmailById(txnId, note ? { note } : {}).catch((error) => {
    console.error(`Failed to send transaction email for txn ${txnId}:`, error);
  });
}

const LOAN_TYPES = [
  {
    type: 'Personal Loan',
    name: 'Personal Loan',
    rate_min: 6.99,
    rate_max: 19.99,
    min: 2000,
    max: 50000,
    term_min: 12,
    term_max: 84,
    features: ['Flexible loan amounts', 'No early repayment fees', 'Quick approval', 'Funds in 24hrs'],
    icon: '💰'
  },
  {
    type: 'Home Loan',
    name: 'Home Loan / Mortgage',
    rate_min: 5.49,
    rate_max: 7.99,
    min: 50000,
    max: 2000000,
    term_min: 120,
    term_max: 360,
    features: ['Competitive variable rates', 'Offset account option', 'Redraw facility', 'Split loan available'],
    icon: '🏠'
  },
  {
    type: 'Car Loan',
    name: 'Car Loan',
    rate_min: 4.99,
    rate_max: 14.99,
    min: 5000,
    max: 150000,
    term_min: 12,
    term_max: 84,
    features: ['Secured & unsecured options', 'Pre-approval available', 'Flexible terms', 'Novated leasing'],
    icon: '🚗'
  },
  {
    type: 'Business Loan',
    name: 'Business Loan',
    rate_min: 7.49,
    rate_max: 22.99,
    min: 10000,
    max: 1000000,
    term_min: 12,
    term_max: 120,
    features: ['Equipment finance', 'Working capital', 'Invoice financing', 'Business overdraft'],
    icon: '🏢'
  },
  {
    type: 'Education Loan',
    name: 'Education / Student Loan',
    rate_min: 3.99,
    rate_max: 9.99,
    min: 1000,
    max: 100000,
    term_min: 12,
    term_max: 120,
    features: ['Study now, pay later', 'Flexible repayment', 'Interest only during study', 'Co-signer option'],
    icon: '🎓'
  },
  {
    type: 'Line of Credit',
    name: 'Line of Credit',
    rate_min: 8.99,
    rate_max: 18.99,
    min: 5000,
    max: 250000,
    term_min: 12,
    term_max: 240,
    features: ['Revolving credit', 'Use what you need', 'Interest only on usage', 'Flexible repayments'],
    icon: '💳'
  }
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
  const emi = principal * monthlyRate * Math.pow(1 + monthlyRate, months) / (Math.pow(1 + monthlyRate, months) - 1);
  return emi;
}

router.get('/', requireAuth, (req, res) => {
  const loans = db.prepare(`
    SELECT l.*, a.account_name as disbursement_account
      , l.loan_amount as principal_amount
      , l.monthly_repayment as monthly_payment
      , l.total_repayment as total_amount
      , l.loan_term_months as term_months
      , (COALESCE(l.total_repayment, 0) - COALESCE(l.remaining_balance, l.loan_amount)) as amount_paid
    FROM loans l
    LEFT JOIN accounts a ON l.account_id = a.id
    WHERE l.user_id = ?
    ORDER BY l.requested_at DESC
  `).all(req.session.userId);

  loans.forEach(loan => {
    loan.payments = db.prepare('SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY payment_date DESC').all(loan.id);
    if (loan.status === 'disbursed') loan.status = 'active';
  });

  res.render('loans/index', {
    title: 'My Loans - United Credit Bank',
    page: 'loans',
    loans,
    loanTypes: LOAN_TYPES.map(buildLoanTypeViewModel)
  });
});

router.get('/apply/new', requireAuth, (req, res) => {
  const query = req.query.type ? `?type=${encodeURIComponent(req.query.type)}` : '';
  res.redirect(`/loans/apply${query}`);
});

router.get('/apply', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  const kyc = db.prepare('SELECT * FROM kyc WHERE user_id = ? AND status = ?').get(req.session.userId, 'approved');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const loanTypes = LOAN_TYPES.map(buildLoanTypeViewModel);
  const selectedLoanType = loanTypes.find(loan => loan.type === req.query.type)?.type || loanTypes[0]?.type || null;

  res.render('loans/apply', {
    title: 'Apply for Loan - United Credit Bank',
    page: 'loans',
    accounts,
    loanTypes,
    selectedLoanType,
    isVerified: !!kyc,
    calculateEMI,
    user
  });
});

router.post('/calculate', requireAuth, (req, res) => {
  const { amount, rate, term } = req.body;
  const emi = calculateEMI(parseFloat(amount), parseFloat(rate), parseInt(term));
  const total = emi * parseInt(term);
  const interest = total - parseFloat(amount);

  res.json({
    emi: emi.toFixed(2),
    total: total.toFixed(2),
    interest: interest.toFixed(2)
  });
});

router.post('/apply', requireAuth, requireVerified, (req, res) => {
  const {
    loan_type,
    purpose, employment_status, annual_income, account_id
  } = req.body;

  const loanType = LOAN_TYPES.find(t => t.type === loan_type);
  if (!loanType) {
    req.session.error = 'Invalid loan type.';
    return res.redirect('/loans/apply');
  }

  const amount = parseFloat(req.body.loan_amount || req.body.principal_amount);
  const rate = parseFloat(req.body.interest_rate || ((loanType.rate_min + loanType.rate_max) / 2).toFixed(2));
  const term = parseInt(req.body.loan_term_months || req.body.term_months);
  const emi = calculateEMI(amount, rate, term);
  const total = emi * term;

  const insert = db.prepare(`
    INSERT INTO loans (user_id, account_id, loan_type, loan_amount, interest_rate, loan_term_months, monthly_repayment, total_repayment, purpose, employment_status, annual_income, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  insert.run(
    req.session.userId,
    account_id || null,
    loan_type,
    amount,
    rate,
    term,
    emi.toFixed(2),
    total.toFixed(2),
    purpose || '',
    employment_status || '',
    parseFloat(annual_income) || 0
  );

  addNotification(req.session.userId, 'Loan Application Submitted', `Your ${loanType.name} application for $${amount.toLocaleString()} is being reviewed.`, 'info');
  req.session.success = `Your ${loanType.name} application has been submitted! We will contact you within 48 hours.`;
  res.redirect('/loans');
});

router.get('/:id', requireAuth, (req, res) => {
  const loan = db.prepare(`
    SELECT l.*, a.account_name, a.account_number
      , l.loan_amount as principal_amount
      , l.monthly_repayment as monthly_payment
      , l.total_repayment as total_amount
      , l.loan_term_months as term_months
      , (COALESCE(l.total_repayment, 0) - COALESCE(l.remaining_balance, l.loan_amount)) as amount_paid
    FROM loans l
    LEFT JOIN accounts a ON l.account_id = a.id
    WHERE l.id = ? AND l.user_id = ?
  `).get(req.params.id, req.session.userId);

  if (!loan) {
    req.session.error = 'Loan not found.';
    return res.redirect('/loans');
  }

  const payments = db.prepare(`
    SELECT *, payment_date as paid_at, payment_date as created_at
    FROM loan_payments
    WHERE loan_id = ?
    ORDER BY payment_date DESC
  `).all(loan.id);
  if (loan.status === 'disbursed') loan.status = 'active';

  res.render('loans/detail', {
    title: `${loan.loan_type} Details - United Credit Bank`,
    page: 'loans',
    loan,
    payments,
    calculateEMI,
    accounts: getUserAccounts(req.session.userId)
  });
});

router.post('/:id/payment', requireAuth, async (req, res) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!loan || loan.status !== 'disbursed') {
    req.session.error = 'Cannot make payment on this loan.';
    return res.redirect('/loans');
  }

  const { amount, payment_method } = req.body;
  const from_account = req.body.from_account || req.body.account_id;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(from_account, req.session.userId);
  if (!account || parseFloat(account.available_balance) < parseFloat(amount)) {
    req.session.error = 'Insufficient funds.';
    return res.redirect(`/loans/${req.params.id}`);
  }

  const restrictionMessage = getAccountStatusMessage(account, 'make loan repayments');
  if (restrictionMessage) {
    req.session.error = restrictionMessage;
    return res.redirect(`/loans/${req.params.id}`);
  }

  const remaining = parseFloat(loan.remaining_balance || loan.loan_amount);
  const payAmount = parseFloat(amount);
  const newRemaining = Math.max(0, remaining - payAmount);

  db.prepare('UPDATE accounts SET balance = balance - ?, available_balance = available_balance - ? WHERE id = ?').run(payAmount, payAmount, from_account);
  db.prepare(`
    INSERT INTO loan_payments (loan_id, amount, payment_method, status)
    VALUES (?, ?, ?, 'completed')
  `).run(req.params.id, payAmount, payment_method || 'bank_transfer');

  db.prepare('UPDATE loans SET remaining_balance = ? WHERE id = ?').run(newRemaining.toFixed(2), req.params.id);

  const txnInsert = db.prepare(`
    INSERT INTO transactions (account_id, user_id, transaction_type, amount, currency, description, status)
    VALUES (?, ?, 'loan_payment', ?, 'AUD', ?, 'completed')
  `);
  const txnInfo = txnInsert.run(from_account, req.session.userId, payAmount, `${loan.loan_type} Repayment - Loan #${loan.id}`);
  const txnId = txnInfo.lastInsertRowid;

  if (isFirestoreEnabled()) {
    try {
      const updatedAccount = db.prepare('SELECT * FROM accounts WHERE id = ?').get(from_account);
      const newTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
      await Promise.all([
        syncAccountToFirestore(updatedAccount),
        syncTransactionToFirestore(newTxn)
      ]);
    } catch (error) {
      console.error('Failed to sync loan payment to Firestore:', error);
    }
  }

  addNotification(req.session.userId, 'Loan Payment Made', `Payment of $${payAmount.toLocaleString()} made to ${loan.loan_type}.`, 'success');
  queueTransactionEmail(txnId, 'Your loan repayment was applied successfully.');
  req.session.success = 'Payment successful!';
  res.redirect(`/loans/${req.params.id}`);
});

router.post('/:id/pay', requireAuth, (req, res) => {
  res.redirect(307, `/loans/${req.params.id}/payment`);
});

module.exports = router;
