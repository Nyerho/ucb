const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFirestoreRepository, resetServiceTokenCacheForTests } = require('../services/firestore-rest');

test('Firestore transaction commits use resource names rather than REST URLs for every mutation type', async () => {
  const privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey;
  const envNames = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch;
  Object.assign(process.env, {
    FIREBASE_PROJECT_ID: 'ucb-firestore-name-test',
    FIREBASE_CLIENT_EMAIL: 'worker-test@example.invalid',
    FIREBASE_PRIVATE_KEY: privateKey
  });
  resetServiceTokenCacheForTests();
  let commitBody;
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      return { ok: true, status: 200, json: async () => ({ access_token: 'test-access-token', expires_in: 3600 }) };
    }
    if (url.pathname.endsWith(':beginTransaction')) {
      return { ok: true, status: 200, json: async () => ({ transaction: 'test-transaction' }) };
    }
    if (url.pathname.endsWith(':commit')) {
      commitBody = JSON.parse(options.body || '{}');
      return { ok: true, status: 200, json: async () => ({ commitTime: '2026-11-26T00:00:00Z' }) };
    }
    throw new Error(`Unexpected request in mocked test: ${url.pathname}`);
  };

  try {
    const repository = createFirestoreRepository();
    const transaction = await repository.runTransaction(tx => {
      tx.set('users', '3', { firebase_uid: 'ucb-3' });
      tx.create('audit_logs', 'audit-1', { action: 'test' });
      tx.update('accounts', 'account-1', { balance_minor: 100 });
      tx.delete('temporary', 'record-1');
      return 'committed';
    });

    assert.equal(transaction.result, 'committed');
    assert.equal(transaction.commitTime, '2026-11-26T00:00:00Z');
    assert.deepEqual(commitBody.writes.map(write => write.update?.name || write.delete), [
      'projects/ucb-firestore-name-test/databases/(default)/documents/users/3',
      'projects/ucb-firestore-name-test/databases/(default)/documents/audit_logs/audit-1',
      'projects/ucb-firestore-name-test/databases/(default)/documents/accounts/account-1',
      'projects/ucb-firestore-name-test/databases/(default)/documents/temporary/record-1'
    ]);
    assert.ok(commitBody.writes.every(write => !String(write.update?.name || write.delete).startsWith('https://')));
  } finally {
    global.fetch = previousFetch;
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
    resetServiceTokenCacheForTests();
  }
});
