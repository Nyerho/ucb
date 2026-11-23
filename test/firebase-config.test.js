const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseServiceAccountJson } = require('../services/firestore-rest');

test('service-account JSON parser accepts a JSON object and treats absence as optional', () => {
  const account = { project_id: 'ucb-test-project', client_email: 'service@example.invalid', private_key: 'test-only-key' };
  assert.deepEqual(parseServiceAccountJson(JSON.stringify(account)), account);
  assert.equal(parseServiceAccountJson(undefined), null);
});

test('service-account JSON parser rejects malformed or non-object values without exposing contents', () => {
  assert.throws(() => parseServiceAccountJson('{not-json'), /must contain valid service-account JSON/);
  assert.throws(() => parseServiceAccountJson('[]'), /must contain a JSON object/);
  assert.throws(() => parseServiceAccountJson('null'), /must contain a JSON object/);
});
