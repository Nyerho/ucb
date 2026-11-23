const { test } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../routes/admin');
const { requireAdmin, isAdminUser } = require('../middleware/auth');
const requireSessionEncryptionReady = require('../middleware/session-encryption-ready');

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
