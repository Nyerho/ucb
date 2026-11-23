'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { toMinorUnits, fromMinorUnits } = require('../services/money');
const { requireAuth, requireVerified, getAccountStatusMessage, generateAccountNumber } = require('../middleware/auth');
const router = express.Router();
const repo = createFirestoreRepository();
router.use(require('../middleware/production-financial-gate'));

function accountForView(account) {
  if (!account) return account;
  return {
    ...account,
    balance: fromMinorUnits(Number(account.balance_minor || 0)),
    available_balance: fromMinorUnits(Number(account.available_balance_minor ?? account.balance_minor ?? 0))
  };
}

function transactionForView(transaction) {
  return {
    ...transaction,
    amount: fromMinorUnits(Number(transaction.amount_minor || 0)),
    fee: fromMinorUnits(Number(transaction.fee_minor || 0))
  };
}

function routeError(req, res, error, fallback) {
  console.error('Account route Firestore operation failed:', error && error.message);
  req.session.error = fallback;
  return res.redirect('/accounts');
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const docs = await repo.list('accounts', [{ field: 'user_id', op: 'EQUAL', value: String(req.auth.uid) }], {
      orderBy: { field: 'created_at', direction: 'ASCENDING' }, limit: 100
    });
    const accounts = docs.map(accountForView);
    res.render('accounts/index', { title: 'My Accounts - United Credit Bank', page: 'accounts', accounts });
  } catch (error) {
    return routeError(req, res, error, 'Accounts are temporarily unavailable. Please try again.');
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const [rawAccount, rawTransactions] = await Promise.all([
      repo.get('accounts', String(req.params.id)),
      repo.list('transactions', [
        { field: 'user_id', op: 'EQUAL', value: String(req.auth.uid) },
        { field: 'account_id', op: 'EQUAL', value: String(req.params.id) }
      ], { orderBy: { field: 'created_at', direction: 'DESCENDING' }, limit: 500 })
    ]);
    if (!rawAccount || String(rawAccount.user_id) !== String(req.auth.uid)) {
      req.session.error = 'Account not found.';
      return res.redirect('/accounts');
    }
    const account = accountForView(rawAccount);
    const transactions = rawTransactions.map(transactionForView);
    const totalDeposits = transactions.filter((t) => t.status === 'completed' &&
      (t.transaction_type === 'admin_adjustment' ? t.amount > 0 : ['deposit', 'loan_disbursement'].includes(t.transaction_type)))
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    const totalWithdrawals = transactions.filter((t) => t.status === 'completed' &&
      (t.transaction_type === 'admin_adjustment' ? t.amount < 0 : ['withdrawal', 'local_transfer', 'international_transfer', 'bill_payment', 'loan_payment'].includes(t.transaction_type)))
      .reduce((sum, t) => sum + Math.abs(t.amount) + Math.abs(t.fee), 0);
    res.render('accounts/detail', {
      title: `${account.account_name} - United Credit Bank`, page: 'accounts', account, transactions, totalDeposits, totalWithdrawals
    });
  } catch (error) {
    return routeError(req, res, error, 'Account details are temporarily unavailable. Please try again.');
  }
});

router.get('/open/new', requireAuth, requireVerified, (req, res) => {
  const accountTypes = [
    { type: 'Everyday Savings', name: 'Everyday Savings Account', min: 0, interest: '0.50%', desc: 'Perfect for everyday banking with no monthly fees' },
    { type: 'High Interest', name: 'High Interest Savings', min: 1000, interest: '4.25%', desc: 'Earn premium interest on your savings' },
    { type: 'Term Deposit', name: 'Term Deposit', min: 5000, interest: '5.10%', desc: 'Locked term for guaranteed returns' },
    { type: 'Business', name: 'Business Account', min: 500, interest: '1.20%', desc: 'Complete business banking solution' },
    { type: 'International', name: 'Multi-Currency Account', min: 100, interest: '0.30%', desc: 'Hold and manage multiple currencies' }
  ];
  res.render('accounts/open', { title: 'Open New Account - United Credit Bank', page: 'accounts', accountTypes });
});

router.post('/open', requireAuth, requireVerified, async (req, res) => {
  const { account_type, initial_deposit } = req.body;
  let initialMinor;
  try {
    initialMinor = toMinorUnits(initial_deposit || '0');
    if (initialMinor < 0) throw new TypeError('Initial deposit cannot be negative.');
  } catch (_) {
    req.session.error = 'Enter a valid non-negative initial deposit.';
    return res.redirect('/accounts/open/new');
  }
  const uid = String(req.auth.uid);
  const accountId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const user = req.user;
    if (!user || String(user.id || user.uid || uid) !== uid) throw new Error('Verified user profile unavailable.');
    const name = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    if (!name) throw new Error('Account holder name unavailable.');
    await repo.runTransaction(async (tx) => {
      const account = {
        user_id: uid, account_number: generateAccountNumber(), account_type: String(account_type || ''),
        account_name: name, balance_minor: initialMinor, available_balance_minor: initialMinor,
        status: 'active', created_at: now, updated_at: now
      };
      tx.create('accounts', accountId, account);
      if (initialMinor > 0) {
        tx.create('transactions', crypto.randomUUID(), {
          user_id: uid, account_id: accountId, transaction_type: 'deposit', amount_minor: initialMinor,
          fee_minor: 0, status: 'completed', description: 'Initial account deposit', created_at: now
        });
      }
      tx.create('ledger_entries', crypto.randomUUID(), {
        user_id: uid, account_id: accountId, entry_type: 'account_opening', amount_minor: initialMinor,
        balance_after_minor: initialMinor, currency: 'AUD', reference_id: accountId, created_at: now
      });
    });
    req.session.success = `Your ${account_type} account has been opened successfully!`;
    return res.redirect('/accounts');
  } catch (error) {
    return routeError(req, res, error, 'Account opening is temporarily unavailable. Please try again.');
  }
});

router.post('/:id/close', requireAuth, requireVerified, async (req, res) => {
  const uid = String(req.auth.uid);
  try {
    const account = await repo.get('accounts', String(req.params.id));
    if (!account || String(account.user_id) !== uid) {
      req.session.error = 'Account not found.';
      return res.redirect('/accounts');
    }
    const restrictionMessage = getAccountStatusMessage(account, 'be closed');
    if (restrictionMessage) {
      req.session.error = restrictionMessage;
      return res.redirect(`/accounts/${req.params.id}`);
    }
    if (Number(account.balance_minor || 0) > 0) {
      req.session.error = 'Please transfer remaining balance before closing.';
      return res.redirect(`/accounts/${req.params.id}`);
    }
    await repo.runTransaction(async (tx) => {
      const current = await tx.get('accounts', String(req.params.id));
      if (!current || String(current.user_id) !== uid || Number(current.balance_minor || 0) !== 0 || current.status !== account.status) {
        throw new Error('Account changed before closure; retry the request.');
      }
      const now = new Date().toISOString();
      tx.update('accounts', String(req.params.id), { status: 'closed', updated_at: now });
      tx.create('ledger_entries', crypto.randomUUID(), {
        user_id: uid, account_id: String(req.params.id), entry_type: 'account_closed', amount_minor: 0,
        balance_after_minor: 0, currency: 'AUD', reference_id: String(req.params.id), created_at: now
      });
    });
    req.session.success = 'Account closed successfully.';
    return res.redirect('/accounts');
  } catch (error) {
    return routeError(req, res, error, 'Account closure is temporarily unavailable. Please try again.');
  }
});

module.exports = router;
