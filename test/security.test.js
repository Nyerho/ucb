const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-not-for-production';
const app = require('../server');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

test('Firestore client profile create and self-update cannot forge Firebase UID binding fields', () => {
  const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
  const protectedFields = rules.match(/function protectedUidBindingFields\(\)\s*\{([\s\S]*?)\n\s*\}/);
  const selfUpdate = rules.match(/function validUserSelfUpdate\(\)\s*\{([\s\S]*?)\n\s*\}/);
  const userCreate = rules.match(/function validUserCreate\(userId\)\s*\{([\s\S]*?)\n\s*\}/);
  const ownership = rules.match(/function ownsUserData\(userId\)\s*\{([\s\S]*?)\n\s*\}/);
  const activeAdmin = rules.match(/function isActiveAdmin\(\)\s*\{([\s\S]*?)\n\s*\}/);
  const superAdmin = rules.match(/function isSuperAdmin\(\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(protectedFields, 'expected the protected UID-binding field list');
  assert.ok(selfUpdate, 'expected the user self-update validation rule');
  assert.ok(userCreate, 'expected the user create validation rule');
  assert.ok(ownership, 'expected the user ownership predicate');
  assert.ok(activeAdmin, 'expected the active administrator authorization rule');
  assert.ok(superAdmin, 'expected the super administrator authorization rule');
  assert.match(selfUpdate[1], /affectedKeys\(\)\.hasAny\(protectedUidBindingFields\(\)\)/);
  assert.match(userCreate[1], /keys\(\)\.hasAny\(protectedUidBindingFields\(\)\)/);
  for (const field of ['firebase_uid', 'firebaseUid', 'uid', 'auth_uid', 'firebase_uid_verified_at']) {
    assert.ok(protectedFields[1].includes(`'${field}'`), `${field} must be protected from client writes`);
  }
  assert.match(activeAdmin[1], /adminData\(\)\.active\s*==\s*true/);
  assert.match(activeAdmin[1], /adminData\(\)\.role\s+in\s+\['admin',\s*'super_admin',\s*'owner'\]/);
  assert.doesNotMatch(activeAdmin[1], /!\s*\(/, 'missing admin fields must never imply active status');
  assert.match(superAdmin[1], /adminData\(\)\.role\s+in\s+\['super_admin',\s*'owner'\]/);
  assert.doesNotMatch(superAdmin[1], /!\s*\(/, 'a missing role must never imply super-admin status');
  assert.match(ownership[1], /userDoc\(userId\)\.firebase_uid\s*==\s*request\.auth\.uid/);
  assert.match(ownership[1], /firebase_uid_verified_at\s+is\s+string/);
  assert.match(ownership[1], /auth_uid.*==\s*request\.auth\.uid/);
  assert.doesNotMatch(ownership[1], /data\.auth_uid\s*==\s*request\.auth\.uid/, 'stale auth_uid alone must not establish ownership');
  assert.match(rules, /allow create: if isActiveAdmin\(\) \|\| validUserCreate\(userId\);/);
  assert.match(rules, /allow update: if isActiveAdmin\(\) \|\| \(ownsUserData\(userId\) && validUserSelfUpdate\(\)\);/);
});

test('public Firestore diagnostics and backfill endpoint is removed', async () => {
  const response = await fetch(`${baseUrl}/api/debug/firestore?backfill_missing=1`);
  assert.equal(response.status, 404);
});

test('account opening validates Firebase UID separately from the profile document ID', () => {
  const accountsRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'accounts.js'), 'utf8');
  assert.match(accountsRoute, /matchesAuthenticatedFirebaseUid\(user, uid\)/);
  assert.doesNotMatch(accountsRoute, /String\(user\.id\s*\|\|\s*user\.uid/);
});

test('admin customer creation points email failures to secure customer recovery, not the disabled reset action', () => {
  const adminRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
  assert.match(adminRoute, /secure Forgot Password flow or contact support/);
  assert.doesNotMatch(adminRoute, /Use the audited reset action to try again/);
});

test('legacy public KYC upload paths are never served', async () => {
  const response = await fetch(`${baseUrl}/uploads/kyc/some-document.jpg`);
  assert.equal(response.status, 404);
});

test('card state changes are not available through GET requests', async () => {
  for (const action of ['freeze', 'unfreeze', 'report', 'replace']) {
    const response = await fetch(`${baseUrl}/cards/1/${action}`, { redirect: 'manual' });
    assert.equal(response.status, 405);
  }
});

test('loan calculator rejects non-finite, negative, and unbounded inputs', async () => {
  for (const payload of [
    { principal: '-1', rate: '5', term: '12' },
    { principal: 'NaN', rate: '5', term: '12' },
    { principal: '1000', rate: '5', term: '0' },
    { principal: '1000', rate: '5', term: '601' }
  ]) {
    const response = await fetch(`${baseUrl}/api/loans/calculate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(response.status, 400);
  }
});

test('production financial gate rejects mutating requests', async () => {
  const gate = require('../middleware/production-financial-gate');
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let statusCode;
  const req = { method: 'POST' };
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { statusCode = code; return this; },
    send(message) { this.message = message; return this; }
  };
  let continued = false;
  gate(req, res, () => { continued = true; });
  process.env.NODE_ENV = original;
  assert.equal(statusCode, 503);
  assert.equal(continued, false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('production financial gate allows only exact safe admin mutation routes', () => {
  const gate = require('../middleware/production-financial-gate');
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const invoke = (req) => {
    let statusCode;
    let continued = false;
    const res = { setHeader() {}, status(code) { statusCode = code; return this; }, send() { return this; } };
    gate(req, res, () => { continued = true; });
    return { statusCode, continued };
  };
  for (const path of ['/users/customer1/update', '/users/create', '/users/customer1/accounts', '/accounts/acc1/balance-adjustment', '/cards/card1/status', '/approvals/kyc/record1/review']) {
    const allowed = invoke({ method: 'POST', baseUrl: '/admin', path });
    assert.equal(allowed.continued, true, `${path} should reach its validated handler`);
  }
  for (const path of ['/users/customer1/delete', '/accounts/adjust', '/accounts/1/balance', '/accounts/1/update/extra', '/approvals/unknown/item/review']) {
    const blocked = invoke({ method: 'POST', baseUrl: '/admin', path });
    assert.equal(blocked.statusCode, 503, `${path} should remain blocked`);
    assert.equal(blocked.continued, false);
  }
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;
});

test('production KYC gate rejects document submissions', () => {
  const gate = require('../middleware/production-pii-gate');
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let statusCode;
  const res = {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { statusCode = code; return this; },
    send(message) { this.message = message; return this; }
  };
  let continued = false;
  gate({ method: 'POST' }, res, () => { continued = true; });
  process.env.NODE_ENV = original;
  assert.equal(statusCode, 503);
  assert.equal(continued, false);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('production serverless persistence gate allows login and exact safe admin mutations only', () => {
  const gate = require('../middleware/serverless-persistence-gate');
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercel = process.env.VERCEL;
  process.env.NODE_ENV = 'production';
  process.env.VERCEL = '1';
  const invoke = (request) => {
    let statusCode;
    let continued = false;
    const res = {
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { statusCode = code; return this; },
      json(body) { this.body = body; return this; }
    };
    gate(request, res, () => { continued = true; });
    return { statusCode, continued, res };
  };
  const login = invoke({ method: 'POST', path: '/auth/login' });
  assert.equal(login.continued, true);
  assert.equal(login.statusCode, undefined);
  const passwordReset = invoke({ method: 'POST', path: '/auth/forgot-password' });
  assert.equal(passwordReset.continued, true);
  assert.equal(passwordReset.statusCode, undefined);
  for (const path of ['/admin/users/create', '/admin/users/customer1/update', '/admin/users/customer1/freeze', '/admin/users/customer1/unfreeze', '/admin/users/customer1/disable', '/admin/users/customer1/restore', '/admin/users/customer1/password-reset', '/admin/users/customer1/accounts', '/admin/accounts/acc1/update', '/admin/accounts/acc1/status', '/admin/accounts/acc1/balance-adjustment', '/admin/cards/card1/status', '/admin/approvals/transfers/txn1/review', '/admin/approvals/kyc/record1/review']) {
    const safe = invoke({ method: 'POST', path });
    assert.equal(safe.continued, true, `${path} should reach its validated handler`);
    assert.equal(safe.statusCode, undefined);
  }
  for (const path of ['/auth/register', '/auth/reset-password', '/auth/forgot-password/extra', '/transfers/local', '/admin/users', '/admin/users/customer1/delete', '/admin/accounts/adjust', '/admin/accounts/acc1/status/extra', '/admin/approvals/unknown/item/review']) {
    const blocked = invoke({ method: 'POST', path });
    assert.equal(blocked.statusCode, 503, `${path} should remain blocked`);
    assert.equal(blocked.continued, false, `${path} should not reach its handler`);
    assert.equal(blocked.res.headers['Cache-Control'], 'no-store');
  }
  const read = invoke({ method: 'GET', path: '/admin/dashboard' });
  assert.equal(read.continued, true);
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
});

test('forgot-password email route requires encrypted-session readiness before dispatch', () => {
  const authRouter = require('../routes/auth');
  const sessionPreflight = require('../middleware/session-encryption-ready');
  const resetRoute = authRouter.stack.find(layer => layer.route && layer.route.path === '/forgot-password' && layer.route.methods.post);
  assert.ok(resetRoute);
  assert.equal(resetRoute.route.stack[0].handle, sessionPreflight);
});

test('admin session preflight rejects missing encryption and proceeds when encryption is ready', async () => {
  const middleware = require('../middleware/session-encryption-ready');
  const session = require('../middleware/firebase-session');
  const originalProbe = session.assertSessionEncryptionReady;
  const originalError = console.error;
  const makeResponse = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; return this; } });
  try {
    console.error = () => {};
    session.assertSessionEncryptionReady = async () => { throw new Error('missing test key'); };
    const blockedRes = makeResponse();
    let blockedNext = false;
    await middleware({}, blockedRes, () => { blockedNext = true; });
    assert.equal(blockedRes.statusCode, 503);
    assert.equal(blockedRes.headers['Cache-Control'], 'no-store');
    assert.equal(blockedNext, false);

    session.assertSessionEncryptionReady = async () => true;
    const readyRes = makeResponse();
    let readyNext = false;
    await middleware({}, readyRes, () => { readyNext = true; });
    assert.equal(readyNext, true);
  } finally {
    session.assertSessionEncryptionReady = originalProbe;
    console.error = originalError;
  }
});

test('encrypted session serialization strips request-derived identity projections', () => {
  const { safeSessionData } = require('../middleware/firebase-session');
  const serialized = safeSessionData({ userId: 'ucb-3', profileId: '3', user: { id: '3' }, success: 'Saved.' });
  assert.deepEqual(serialized, { success: 'Saved.' });
});

test('production serverless readiness endpoint reports durable storage blocker', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVercel = process.env.VERCEL;
  process.env.NODE_ENV = 'production';
  process.env.VERCEL = '1';
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'not_ready',
      reason: 'durable_store_unconfigured'
    });
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
  }
});
