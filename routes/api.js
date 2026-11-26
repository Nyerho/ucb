'use strict';
const express = require('express');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { readMinorUnits, fromMinorUnits } = require('../services/money');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { getRuntimeEnv } = require('../lib/runtime-env');
const { ownerIdsForRequest, listByOwnerIds, recordHasOwnerId } = require('../services/owner-records');

const router = express.Router();
const repo = createFirestoreRepository();

function displayMoney(document, field) {
  const minorField = `${field}_minor`;
  const fallback = field === 'available_balance' ? readMinorUnits(document, 'balance_minor', 'balance') : 0;
  return fromMinorUnits(readMinorUnits(document, minorField, field, fallback));
}

function withAccountDisplay(account) {
  return {
    ...account,
    balance: displayMoney(account, 'balance'),
    available_balance: displayMoney(account, 'available_balance')
  };
}

router.get('/user/dashboard-stats', requireAuth, async (req, res) => {
  try {
    const owners = ownerIdsForRequest(req);
    const accounts = await listByOwnerIds(repo, 'accounts', owners);
    const totalBalance = accounts.reduce((sum, account) => sum + displayMoney(account, 'balance'), 0);
    const totalAvailable = accounts.reduce((sum, account) => sum + displayMoney(account, 'available_balance'), 0);
    const transactions = await listByOwnerIds(repo, 'transactions', owners,
      [{ field: 'status', value: 'completed' }],
      { orderBy: { field: 'created_at', direction: 'DESCENDING' }, limit: 1000 });
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const totals = new Map();
    for (const transaction of transactions) {
      const createdAt = Date.parse(transaction.created_at || '');
      if (!Number.isFinite(createdAt) || createdAt < cutoff) continue;
      const type = transaction.transaction_type;
      if (!type) continue;
      const amount = fromMinorUnits(readMinorUnits(transaction, 'amount_minor', 'amount'));
      totals.set(type, (totals.get(type) || 0) + amount);
    }
    res.json({
      totalBalance,
      totalAvailable,
      accountCount: accounts.length,
      last7Days: Array.from(totals, ([transaction_type, total]) => ({ transaction_type, total }))
    });
  } catch (error) {
    console.error('Dashboard Firestore read failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.get('/user/notifications', requireAuth, async (req, res) => {
  try {
    const notifications = await listByOwnerIds(repo, 'notifications', ownerIdsForRequest(req), [], {
      orderBy: { field: 'created_at', direction: 'DESCENDING' }, limit: 20
    });
    const unread = notifications.filter((item) => item.is_read === false || item.is_read === 0).length;
    res.json({ notifications, unread });
  } catch (error) {
    console.error('Notifications Firestore read failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.post('/user/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const notification = await repo.get('notifications', req.params.id);
    if (notification && recordHasOwnerId(notification, ownerIdsForRequest(req))) {
      await repo.update('notifications', req.params.id, { is_read: true });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Notification update failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.post('/user/notifications/read-all', requireAuth, async (req, res) => {
  try {
    const notifications = await listByOwnerIds(repo, 'notifications', ownerIdsForRequest(req));
    await Promise.all(notifications.filter((item) => item.is_read !== true && item.is_read !== 1)
      .map((item) => repo.update('notifications', item.id, { is_read: true })));
    res.json({ success: true });
  } catch (error) {
    console.error('Notification bulk update failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.get('/user/accounts-summary', requireAuth, async (req, res) => {
  try {
    const accounts = await listByOwnerIds(repo, 'accounts', ownerIdsForRequest(req), [
      { field: 'status', value: 'active' }
    ]);
    res.json({ accounts: accounts.map((account) => {
      const display = withAccountDisplay(account);
      return Object.fromEntries(['id', 'account_number', 'account_name', 'account_type', 'currency', 'balance', 'available_balance', 'status']
        .filter((key) => display[key] !== undefined).map((key) => [key, display[key]]));
    }) });
  } catch (error) {
    console.error('Account summary Firestore read failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.get('/search/beneficiaries', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').toLowerCase();
    const beneficiaries = await listByOwnerIds(repo, 'beneficiaries', ownerIdsForRequest(req));
    const results = beneficiaries.filter((item) => String(item.name || '').toLowerCase().includes(q)
      || String(item.account_number || '').toLowerCase().includes(q)).slice(0, 10);
    res.json({ results });
  } catch (error) {
    console.error('Beneficiary search Firestore read failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.post('/admin/search-users', requireAdmin, async (req, res) => {
  try {
    const q = String(req.body.query || '').toLowerCase();
    const profiles = await repo.list('users', [], { limit: 1000 });
    const users = profiles.filter((user) => !user.is_admin && ['first_name', 'last_name', 'email', 'phone']
      .some((field) => String(user[field] || '').toLowerCase().includes(q)))
      .slice(0, 20)
      .map((user) => Object.fromEntries(['id', 'first_name', 'last_name', 'email', 'phone', 'is_frozen', 'is_verified', 'created_at']
        .map((field) => [field, field === 'id' ? user.id : user[field]])));
    res.json({ users });
  } catch (error) {
    console.error('Admin user search Firestore read failed:', error.message);
    res.status(503).json({ error: 'Service temporarily unavailable.' });
  }
});

router.post('/loans/calculate', (req, res) => {
  const { principal, rate, term } = req.body;
  const p = Number(principal);
  const annualRate = Number(rate);
  const n = Number(term);
  if (!Number.isFinite(p) || p <= 0 || p > 100000000 || !Number.isFinite(annualRate) || annualRate < 0 || annualRate > 100 || !Number.isInteger(n) || n < 1 || n > 600) {
    return res.status(400).json({ error: 'Enter a valid principal, rate, and term.' });
  }
  const r = annualRate / 100 / 12;
  if (r === 0) {
    const emi = p / n;
    return res.json({ emi: emi.toFixed(2), total: p.toFixed(2), interest: '0.00' });
  }
  const emi = (p * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  const total = emi * n;
  const interest = total - p;
  res.json({
    emi: emi.toFixed(2),
    total: total.toFixed(2),
    interest: interest.toFixed(2),
    schedule: Array.from({ length: Math.min(n, 12) }, (_, i) => ({
      month: i + 1,
      payment: emi.toFixed(2),
      principal: (emi * Math.pow(1 + r, -(n - i)) - (i === 0 ? 0 : emi * Math.pow(1 + r, -(n - i + 1)))).toFixed(2)
    }))
  });
});

router.get('/exchange/rates', (req, res) => {
  res.json({
    base: 'AUD',
    rates: {
      USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50,
      SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75,
      CHF: 0.59, SEK: 6.95, KRW: 876.50, THB: 23.45, MYR: 3.08,
      PHP: 37.25, IDR: 10280.00, VND: 16180.00, ZAR: 11.45
    },
    updated: new Date().toISOString()
  });
});

router.get('/bsb/lookup', (req, res) => {
  const bsb = req.query.bsb || '';
  const banks = {
    '082': 'National Australia Bank (NAB)', '012': 'Australia and New Zealand Banking Group (ANZ)',
    '032': 'Australia and New Zealand Banking Group (ANZ)', '062': 'Commonwealth Bank of Australia (CBA)',
    '064': 'Commonwealth Bank of Australia (CBA)', '067': 'Commonwealth Bank of Australia (CBA)',
    '146': 'Westpac Banking Corporation', '733': 'Bendigo Bank', '633': 'Bendigo Bank',
    '980': 'Bank of Melbourne', '484': 'Suncorp Bank', '802': 'ING Bank Australia',
    '412': 'Bank of Queensland (BOQ)', '630': 'Heritage Bank', '636': 'Great Southern Bank'
  };
  const prefix = bsb.slice(0, 3);
  res.json({ bsb, bank: banks[prefix] || 'Unknown Bank', valid: /^\d{3}-\d{3}$/.test(bsb) || /^\d{6}$/.test(bsb) });
});

router.get('/health', async (req, res) => {
  if (process.env.NODE_ENV === 'production' && (getRuntimeEnv('WORKER_RUNTIME') === '1' || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)) {
    return res.status(503).json({ status: 'not_ready', reason: 'durable_store_unconfigured' });
  }
  try {
    await repo.list('users', [], { limit: 1 });
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
  } catch (error) {
    console.error('Health check Firestore query failed:', error.message);
    res.status(503).json({ status: 'error' });
  }
});

module.exports = router;
