const express = require('express');
const { db } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  getFirestoreAdminDiagnostics,
  logFirestoreDiagnostics,
  hasAdminCredentials,
  getResolvedProjectId
} = require('../lib/firebase-admin');
const {
  isFirestoreEnabled,
  firestoreUserExistsByEmail,
  syncUserBundleToFirestore
} = require('../services/firestore-sync');

const router = express.Router();

router.get('/user/dashboard-stats', requireAuth, (req, res) => {
  const userId = req.session.userId;
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId);
  const totalBalance = accounts.reduce((s, a) => s + parseFloat(a.balance), 0);
  const totalAvailable = accounts.reduce((s, a) => s + parseFloat(a.available_balance), 0);

  const txn7d = db.prepare(`
    SELECT transaction_type, SUM(amount) as total
    FROM transactions
    WHERE user_id = ? AND status = 'completed' AND created_at >= DATE('now', '-7 days')
    GROUP BY transaction_type
  `).all(userId);

  res.json({
    totalBalance,
    totalAvailable,
    accountCount: accounts.length,
    last7Days: txn7d
  });
});

router.get('/user/notifications', requireAuth, (req, res) => {
  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(req.session.userId);

  const unread = notifications.filter(n => n.is_read === 0).length;
  res.json({ notifications, unread });
});

router.post('/user/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
  res.json({ success: true });
});

router.post('/user/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.userId);
  res.json({ success: true });
});

router.get('/user/accounts-summary', requireAuth, (req, res) => {
  const accounts = db.prepare(`
    SELECT id, account_number, account_name, account_type, currency, balance, available_balance, status
    FROM accounts WHERE user_id = ? AND status = 'active'
  `).all(req.session.userId);

  res.json({ accounts });
});

router.get('/search/beneficiaries', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const results = db.prepare(`
    SELECT * FROM beneficiaries
    WHERE user_id = ? AND (LOWER(name) LIKE ? OR LOWER(account_number) LIKE ?)
    LIMIT 10
  `).all(req.session.userId, `%${q}%`, `%${q}%`);
  res.json({ results });
});

router.post('/admin/search-users', requireAdmin, (req, res) => {
  const q = (req.body.query || '').toLowerCase();
  const users = db.prepare(`
    SELECT id, first_name, last_name, email, phone, is_frozen, is_verified, created_at
    FROM users
    WHERE is_admin = 0 AND (LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(phone) LIKE ?)
    LIMIT 20
  `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  res.json({ users });
});

router.post('/loans/calculate', (req, res) => {
  const { principal, rate, term } = req.body;
  const p = parseFloat(principal) || 0;
  const r = parseFloat(rate) / 100 / 12;
  const n = parseInt(term) || 0;

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
    '082': 'National Australia Bank (NAB)',
    '012': 'Australia and New Zealand Banking Group (ANZ)',
    '032': 'Australia and New Zealand Banking Group (ANZ)',
    '062': 'Commonwealth Bank of Australia (CBA)',
    '064': 'Commonwealth Bank of Australia (CBA)',
    '067': 'Commonwealth Bank of Australia (CBA)',
    '146': 'Westpac Banking Corporation',
    '733': 'Bendigo Bank',
    '633': 'Bendigo Bank',
    '980': 'Bank of Melbourne',
    '484': 'Suncorp Bank',
    '802': 'ING Bank Australia',
    '412': 'Bank of Queensland (BOQ)',
    '630': 'Heritage Bank',
    '636': 'Great Southern Bank'
  };

  const prefix = bsb.slice(0, 3);
  res.json({
    bsb,
    bank: banks[prefix] || 'Unknown Bank',
    valid: /^\d{3}-\d{3}$/.test(bsb) || /^\d{6}$/.test(bsb)
  });
});

router.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/debug/firestore', async (req, res) => {
  const diag = getFirestoreAdminDiagnostics();
  const forceDiag = req.query.force === '1';
  if (forceDiag) {
    logFirestoreDiagnostics(true);
  }
  const testEmail = req.query.test_email
    ? String(req.query.test_email).trim().toLowerCase()
    : null;

  const result = {
    timestamp: new Date().toISOString(),
    runtime: diag.runtime,
    resolvedProjectId: getResolvedProjectId(),
    hasAdminCredentials: hasAdminCredentials(),
    isFirestoreEnabled: false,
    diagnostics: diag,
    notes: [
      'If private_key_valid = NO, fix env var in Vercel Settings → Environment Variables → Redeploy',
      'If isFirestoreEnabled = YES but users still not appearing, visit:',
      '   /api/debug/firestore?backfill_missing=1 to rescue all local SQLite users',
    ]
  };

  try {
    result.isFirestoreEnabled = isFirestoreEnabled();
  } catch (err) {
    result.isFirestoreEnabled = false;
    result.isFirestoreEnabledError = String(err.message || err);
  }

  if (testEmail) {
    try {
      result.testEmail = testEmail;
      const local = db.prepare('SELECT id, email, first_name, last_name, created_at FROM users WHERE email = ?').get(testEmail);
      result.localUserFound = Boolean(local);
      result.localUser = local || null;

      if (result.isFirestoreEnabled) {
        result.firestoreUserExists = await firestoreUserExistsByEmail(testEmail);
        if (local && !result.firestoreUserExists && req.query.force_sync === '1') {
          result.forcedSyncResult = await syncUserBundleToFirestore(local.id);
        }
      }
    } catch (err) {
      result.testEmailError = String(err.message || err);
    }
  }

  if (req.query.backfill_missing === '1') {
    result.backfill = { started: true, message: 'Backfill triggered - check server logs for details. This endpoint does not wait for completion.' };
    (async () => {
      try {
        const { backfillLocalUsersToFirestore } = require('../services/firestore-sync');
        await backfillLocalUsersToFirestore(500);
      } catch (e) {
        console.error('/api/debug/firestore backfill error:', e);
      }
    })();
  }

  const safeForPublic = { ...result };
  if (safeForPublic.diagnostics) {
    safeForPublic.diagnostics = {
      ...safeForPublic.diagnostics,
      clientEmailValue: undefined,
    };
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.json(safeForPublic);
});

module.exports = router;
