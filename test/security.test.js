const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

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

test('public Firestore diagnostics and backfill endpoint is removed', async () => {
  const response = await fetch(`${baseUrl}/api/debug/firestore?backfill_missing=1`);
  assert.equal(response.status, 404);
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

test('production serverless persistence gate allows only login among mutations and permits reads', () => {
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
  for (const path of ['/auth/register', '/auth/forgot-password', '/transfers/local', '/admin/users']) {
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
