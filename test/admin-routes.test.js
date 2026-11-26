const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const router = require('../routes/admin');
const { requireAdmin, isAdminUser } = require('../middleware/auth');
const requireSessionEncryptionReady = require('../middleware/session-encryption-ready');
const { resetServiceTokenCacheForTests, toFirestoreValue } = require('../services/firestore-rest');

function firestoreDocument(collection, record) {
  const { id, __storedIdField, ...fields } = record;
  if (__storedIdField !== undefined) fields.id = __storedIdField;
  return {
    name: `projects/ucb-admin-route-test/databases/(default)/documents/${collection}/${id}`,
    fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, toFirestoreValue(value)]))
  };
}

function collectFieldFilters(where, output = []) {
  if (!where) return output;
  if (where.fieldFilter) output.push(where.fieldFilter);
  for (const filter of where.compositeFilter?.filters || []) collectFieldFilters(filter, output);
  return output;
}

function mockFirestore(fixtures) {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey;
  const envNames = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch;
  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: 'ucb-admin-route-test',
    FIREBASE_CLIENT_EMAIL: 'worker-test@example.invalid',
    FIREBASE_PRIVATE_KEY: privateKey
  });
  resetServiceTokenCacheForTests();
  const queries = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.href.startsWith('https://oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
    }
    if (url.pathname.endsWith(':runQuery')) {
      const query = JSON.parse(options.body).structuredQuery;
      queries.push(query);
      const collection = query.from[0].collectionId;
      const filters = collectFieldFilters(query.where);
      const records = (fixtures[collection] || []).filter(record => filters.every(filter => {
        const expected = filter.value.stringValue ?? filter.value.integerValue ?? filter.value.booleanValue;
        return record[filter.field.fieldPath] === expected;
      }));
      return { ok: true, status: 200, json: async () => records.map(record => ({ document: firestoreDocument(collection, record) })) };
    }
    const match = /\/documents\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const [, collection, encodedId] = match;
      const docId = decodeURIComponent(encodedId);
      const record = (fixtures[collection] || []).find(item => String(item.id) === docId);
      if (record) return { ok: true, status: 200, json: async () => firestoreDocument(collection, record) };
      return { ok: false, status: 404, json: async () => ({ error: { status: 'NOT_FOUND' } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return {
    queries,
    restore() {
      global.fetch = previousFetch;
      for (const name of envNames) {
        if (previousEnv[name] === undefined) delete process.env[name];
        else process.env[name] = previousEnv[name];
      }
      resetServiceTokenCacheForTests();
    }
  };
}

test('admin router registers only the reviewed safe POST handlers', () => {
  const writes = router.stack.filter(layer => layer.route && layer.route.methods.post);
  const paths = writes.map(layer => layer.route.path).sort();
  assert.deepEqual(paths, [
    '/accounts/:id/balance-adjustment',
    '/accounts/:id/status',
    '/accounts/:id/update',
    '/approvals/:kind/:id/review',
    '/cards/:id/status',
    '/users/:id/accounts',
    '/users/:id/disable',
    '/users/:id/freeze',
    '/users/:id/password-reset',
    '/users/:id/restore',
    '/users/:id/unfreeze',
    '/users/:id/update',
    '/users/create'
  ].sort());
  for (const layer of writes) {
    assert.equal(layer.route.stack.some(item => item.handle === requireSessionEncryptionReady), true, `${layer.route.path} must run the session preflight`);
  }
  const adminGuardIndex = router.stack.findIndex(layer => layer.handle === requireAdmin);
  const firstWriteIndex = router.stack.findIndex(layer => layer.route && layer.route.methods.post);
  assert.ok(adminGuardIndex >= 0 && adminGuardIndex < firstWriteIndex, 'all admin routes must be protected before the handlers');
});

test('admin POST handler redirects after a rejected workflow instead of throwing while reading its result', async () => {
  const layer = router.stack.find(item => item.route && item.route.path === '/accounts/:id/status');
  const handler = layer.route.stack.at(-1).handle;
  const req = {
    auth: { uid: 'admin1' }, params: { id: 'acc1' },
    body: { status: ['active'], reason: 'A sufficiently long reason' }, session: {}
  };
  const res = { redirect(path) { this.location = path; return this; } };
  await handler(req, res);
  assert.equal(res.location, '/admin/accounts/acc1');
  assert.match(req.session.error, /Choose active, frozen, blocked, or closed status/);
});

test('Firebase customer-creation failures redirect to the creation form without making a network request', async () => {
  const layer = router.stack.find(item => item.route && item.route.path === '/users/create' && item.route.methods.post);
  const handler = layer.route.stack.at(-1).handle;
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  global.fetch = async () => { throw new Error('Network disabled in unit test.'); };
  console.error = () => {};
  const req = {
    auth: { uid: 'admin1' }, body: { email: 'customer@example.test' },
    ip: '127.0.0.1', session: {}
  };
  const res = { redirect(path) { this.location = path; return this; } };
  try {
    await handler(req, res);
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
  assert.equal(res.location, '/admin/users/create');
  assert.match(req.session.error, /change could not be confirmed/);
});

test('admin dashboard renders an admins-only identity from the verified request profile', async () => {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey;
  const envNames = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch;
  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: 'ucb-dashboard-test',
    FIREBASE_CLIENT_EMAIL: 'worker-test@example.invalid',
    FIREBASE_PRIVATE_KEY: privateKey
  });
  resetServiceTokenCacheForTests();
  const queryBodies = [];
  global.fetch = async (input, options = {}) => {
    if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
    }
    if (String(input).includes(':runQuery')) queryBodies.push(JSON.parse(options.body).structuredQuery);
    return { ok: true, status: 200, json: async () => [] };
  };

  const layer = router.stack.find(item => item.route && item.route.path === '/dashboard' && item.route.methods.get);
  const handler = layer.route.stack.at(-1).handle;
  const admin = { id: 'admin-only-uid', first_name: 'System', role: 'super_admin', is_admin: 1 };
  const req = { user: admin, session: { userId: admin.id } };
  const res = { render(view, locals) { this.view = view; this.locals = locals; return this; } };
  let nextError;

  try {
    await handler(req, res, error => { nextError = error; });
    assert.equal(nextError, undefined);
    assert.equal(res.view, 'admin/dashboard');
    assert.equal(res.locals.user, admin);
    assert.equal(res.locals.user.first_name, 'System');
    for (const collectionId of ['kyc', 'bill_payments']) {
      const query = queryBodies.find(item => item.from[0].collectionId === collectionId);
      assert.ok(query, `expected a query for ${collectionId}`);
      assert.equal(query.where.fieldFilter.field.fieldPath, 'status');
      assert.equal(query.orderBy, undefined);
    }
  } finally {
    global.fetch = previousFetch;
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
    resetServiceTokenCacheForTests();
  }
});

test('admin customer list and detail resolve numeric profiles and query only the exact UID/profile-ID pair', async () => {
  const fixtures = {
    users: [{ id: '3', __storedIdField: 'ucb-3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', first_name: 'Ada', last_name: 'Customer', email: 'ada@example.test', phone: '+61 400 111 222', is_admin: 0, is_verified: 1, is_frozen: 0, created_at: '2026-11-20T10:00:00.000Z' }],
    accounts: [
      { id: 'account-3', user_id: 'ucb-3', account_name: 'Ada Everyday', account_type: 'Everyday Savings', account_number: '12345678', status: 'active', currency: 'AUD', balance_minor: 15000, available_balance_minor: 15000, created_at: '2026-11-21T10:00:00.000Z' },
      { id: 'account-other', user_id: 'ucb-4', account_name: 'Other Customer Account', account_number: '87654321', created_at: '2026-11-21T10:00:00.000Z' }
    ],
    transactions: [
      { id: 'transaction-3', user_id: 'ucb-3', account_id: 'account-3', transaction_type: 'deposit', amount_minor: 15000, currency: 'AUD', status: 'completed', created_at: '2026-11-21T10:00:00.000Z' },
      { id: 'transaction-mismatched-account', user_id: 'ucb-3', account_id: 'account-other', transaction_type: 'deposit', amount_minor: 1, currency: 'AUD', status: 'completed', created_at: '2026-11-20T10:00:00.000Z' }
    ],
    cards: [{ id: 'card-3', user_id: 'ucb-3', card_type: 'Debit Card', card_number: '4111111111111111', status: 'active', created_at: '2026-11-21T10:00:00.000Z' }],
    loans: [{ id: 'loan-3', user_id: 'ucb-3', loan_type: 'Personal Loan', loan_amount_minor: 200000, status: 'pending', created_at: '2026-11-21T10:00:00.000Z' }],
    kyc: [{ id: 'kyc-3', user_id: 'ucb-3', document_type: 'Passport', status: 'pending', submitted_at: '2026-11-21T10:00:00.000Z' }],
    notifications: [{ id: 'notification-3', user_id: 'ucb-3', title: 'Account notice', created_at: '2026-11-21T10:00:00.000Z' }],
    audit_logs: []
  };
  const firebase = mockFirestore(fixtures);
  try {
    const listHandler = router.stack.find(layer => layer.route && layer.route.path === '/users' && layer.route.methods.get).route.stack.at(-1).handle;
    const listRes = { render(view, locals) { this.view = view; this.locals = locals; return this; } };
    let nextError;
    await listHandler({ query: {} }, listRes, error => { nextError = error; });
    assert.equal(nextError, undefined);
    assert.equal(listRes.view, 'admin/users');
    assert.equal(listRes.locals.users[0].id, '3', 'profile document ID remains the customer action target');
    assert.equal(listRes.locals.users[0].firebaseUid, 'ucb-3');
    assert.equal(listRes.locals.userAccounts['3'][0].user_id, 'ucb-3');
    const listAccountQueries = firebase.queries.filter(query => query.from[0].collectionId === 'accounts' && collectFieldFilters(query.where).some(filter => filter.field.fieldPath === 'user_id'));
    assert.equal(listAccountQueries.length, 2, 'list page must query both exact owner IDs');
    assert.deepEqual(listAccountQueries.map(query => collectFieldFilters(query.where).find(filter => filter.field.fieldPath === 'user_id').value.stringValue), ['ucb-3', '3']);

    firebase.queries.length = 0;
    const detailHandler = router.stack.find(layer => layer.route && layer.route.path === '/users/:id' && layer.route.methods.get).route.stack.at(-1).handle;
    const detailRes = { render(view, locals) { this.view = view; this.locals = locals; return this; }, redirect(path) { this.location = path; return this; } };
    await detailHandler({ params: { id: 'ucb-3' }, session: {} }, detailRes, error => { nextError = error; });
    assert.equal(nextError, undefined);
    assert.equal(detailRes.view, 'admin/user-detail');
    assert.equal(detailRes.locals.customer.id, '3');
    assert.equal(detailRes.locals.customer.firebaseUid, 'ucb-3');
    for (const field of ['accounts', 'transactions', 'cards', 'loans', 'kyc', 'notifications']) {
      assert.equal(detailRes.locals[field].length, field === 'transactions' ? 2 : 1, `${field} should be found for the Firebase owner`);
      assert.ok(detailRes.locals[field].every(record => record.user_id === 'ucb-3'));
    }
    const mismatchedTransaction = detailRes.locals.transactions.find(record => record.id === 'transaction-mismatched-account');
    assert.equal(mismatchedTransaction.account_name, '', 'a transaction cannot disclose an unrelated account name');
    const ownedCollections = new Set(['accounts', 'transactions', 'cards', 'loans', 'kyc', 'notifications']);
    const ownerQueries = firebase.queries.filter(query => ownedCollections.has(query.from[0].collectionId) && collectFieldFilters(query.where).some(filter => filter.field.fieldPath === 'user_id'));
    assert.equal(ownerQueries.length, ownedCollections.size * 2);
    for (const collection of ownedCollections) {
      const collectionOwners = ownerQueries.filter(query => query.from[0].collectionId === collection).map(query => collectFieldFilters(query.where).find(filter => filter.field.fieldPath === 'user_id').value.stringValue);
      assert.deepEqual(collectionOwners, ['ucb-3', '3'], `${collection} must query the Firebase UID plus only its exact legacy profile ID`);
    }

    firebase.queries.length = 0;
    nextError = undefined;
    const directRes = { render(view, locals) { this.view = view; this.locals = locals; return this; }, redirect(path) { this.location = path; return this; } };
    await detailHandler({ params: { id: '3' }, session: {} }, directRes, error => { nextError = error; });
    assert.equal(nextError, undefined);
    assert.equal(directRes.locals.customer.id, '3', 'the Firestore document key wins over its stored id field');
    assert.equal(directRes.locals.customer.firebaseUid, 'ucb-3');
  } finally {
    firebase.restore();
  }
});

test('admin routes do not associate UID-owned records with an unbound numeric profile', async () => {
  const firebase = mockFirestore({
    users: [{ id: '3', first_name: 'Unbound', last_name: 'Customer', email: 'customer@example.test', is_admin: 0 }],
    accounts: [{ id: 'account-3', user_id: 'ucb-3', account_name: 'Unowned link', created_at: '2026-11-21T10:00:00.000Z' }]
  });
  try {
    const listHandler = router.stack.find(layer => layer.route && layer.route.path === '/users' && layer.route.methods.get).route.stack.at(-1).handle;
    const listRes = { render(view, locals) { this.view = view; this.locals = locals; return this; } };
    await listHandler({ query: {} }, listRes, () => {});
    assert.equal(listRes.locals.users[0].firebaseUid, '');
    assert.deepEqual(listRes.locals.userAccounts['3'], []);

    const detailHandler = router.stack.find(layer => layer.route && layer.route.path === '/users/:id' && layer.route.methods.get).route.stack.at(-1).handle;
    const detailRes = { redirect(path) { this.location = path; return this; } };
    await detailHandler({ params: { id: 'ucb-3' }, session: {} }, detailRes, () => {});
    assert.equal(detailRes.location, '/admin/users');
  } finally {
    firebase.restore();
  }
});

test('admin guard accepts administrator and super_admin Firebase profiles but rejects customers', () => {
  assert.equal(isAdminUser({ is_admin: '0', role: 'customer' }), false);
  assert.equal(isAdminUser({ is_admin: 0, role: 'super_admin' }), true);
  for (const role of ['admin', 'super_admin']) {
    const req = { auth: { uid: 'admin1' }, user: { role }, session: {} };
    const res = { redirect(path) { this.location = path; return this; } };
    let continued = false;
    requireAdmin(req, res, () => { continued = true; });
    assert.equal(continued, true, `${role} should reach the admin router`);
  }
  const req = { auth: { uid: 'customer1' }, user: { role: 'customer', is_admin: 0 }, session: {} };
  const res = { redirect(path) { this.location = path; return this; } };
  let continued = false;
  requireAdmin(req, res, () => { continued = true; });
  assert.equal(continued, false);
  assert.equal(res.location, '/user/dashboard');
});
