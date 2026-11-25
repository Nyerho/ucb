const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');

const dashboardView = path.join(__dirname, '..', 'views', 'admin', 'dashboard.ejs');

test('admin dashboard renders valid inline config and tolerates a legacy transaction without transaction_type', async () => {
  const stats = {
    totalCustomers: 0,
    newThisWeek: 0,
    activeAccounts: 0,
    totalBalance: 0,
    todayTransactions: 0,
    todayVolume: 0,
    activeCards: 0,
    pendingCards: 0,
    totalLoansOutstanding: 0,
    activeLoans: 0,
    frozenAccounts: 0,
    unverifiedCustomers: 0
  };
  for (const field of ['pendingKYC', 'pendingTransfers', 'pendingCards', 'pendingLoans', 'pendingBills']) stats[field] = 0;

  const html = await ejs.renderFile(dashboardView, {
    title: 'Admin Dashboard - United Credit Bank',
    page: 'admin-dashboard',
    user: { id: 'admin-only-uid', first_name: 'System', last_name: 'Administrator', email: 'admin@example.test' },
    admin: { id: 'admin-only-uid', first_name: 'System', last_name: 'Administrator' },
    stats,
    pendingCount: 0,
    recentUsers: [],
    recentTransactions: [{
      id: 'legacy-transaction',
      amount: 1250,
      currency: 'AUD',
      status: 'completed',
      created_at: '2026-11-25T00:00:00.000Z'
    }],
    currency: amount => `AUD ${Number(amount).toFixed(2)}`,
    moment: () => ({ format: () => '25 Nov 00:00' })
  });

  assert.match(html, /window\.__FIREBASE_CONFIG__ = null;/);
  assert.doesNotMatch(html, /window\.__FIREBASE_CONFIG__ =\s*;/);
  assert.match(html, />Transaction<\/div>/);

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .filter(Boolean);
  for (const script of inlineScripts) vm.runInNewContext(script, { window: {} });
});
