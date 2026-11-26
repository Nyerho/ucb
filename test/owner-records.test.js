const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ownerIdsForIdentity, ownerIdsForRequest, listByOwnerIds, recordHasOwnerId } = require('../services/owner-records');

test('request owner IDs include a legacy numeric profile only when the request has the confirmed canonical binding', () => {
  const boundProfile = { uid: 'ucb-3', firebaseUid: 'ucb-3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', id: '3', profileId: '3' };
  assert.deepEqual(ownerIdsForRequest({
    auth: { uid: 'ucb-3' }, session: { profileId: '3' }, user: boundProfile
  }), ['ucb-3', '3']);
  assert.deepEqual(ownerIdsForRequest({
    auth: { uid: 'ucb-3' }, session: { profileId: '3' }, user: { uid: 'ucb-3', profileId: '3' }
  }), ['ucb-3']);
  assert.deepEqual(ownerIdsForRequest({ auth: { uid: '12345' }, user: { uid: '12345', profileId: '12345' } }), ['12345']);
});

test('admin/customer identity owner IDs remain constrained to the exact ucb-number profile mapping', () => {
  const boundProfile = { firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z' };
  assert.deepEqual(ownerIdsForIdentity('ucb-3', '3', boundProfile), ['ucb-3', '3']);
  assert.deepEqual(ownerIdsForIdentity('ucb-3', '3'), ['ucb-3']);
  assert.deepEqual(ownerIdsForIdentity('ucb-3', '4', boundProfile), ['ucb-3']);
  assert.deepEqual(ownerIdsForIdentity('other-uid', '3', boundProfile), ['other-uid']);
  assert.deepEqual(ownerIdsForIdentity('', '3', boundProfile), []);
});

test('dual owner query unions and globally orders UID-keyed and legacy profile-ID records', async () => {
  const calls = [];
  const repository = {
    async list(collection, filters, options) {
      calls.push({ collection, filters, options });
      const owner = filters[0].value;
      if (owner === 'ucb-3') return [
        { id: 'uid-new', user_id: 'ucb-3', created_at: '2026-11-25T10:00:00.000Z' },
        { id: 'shared', user_id: 'ucb-3', created_at: '2026-11-25T09:00:00.000Z' }
      ];
      return [
        { id: 'legacy-old', user_id: '3', created_at: '2026-11-25T08:00:00.000Z' },
        { id: 'shared', user_id: '3', created_at: '2026-11-25T09:00:00.000Z' }
      ];
    }
  };
  const rows = await listByOwnerIds(repository, 'transactions', ['ucb-3', '3'],
    [{ field: 'status', value: 'completed' }],
    { orderBy: { field: 'created_at', direction: 'DESCENDING' }, limit: 3 });
  assert.deepEqual(calls.map(call => call.filters[0].value), ['ucb-3', '3']);
  assert.ok(calls.every(call => call.collection === 'transactions' && call.filters[1].value === 'completed'));
  assert.deepEqual(rows.map(row => row.id), ['uid-new', 'shared', 'legacy-old']);
  assert.equal(rows.length, 3);
});

test('mixed UID/profile-ID financial collections return both existing record families without broadening ownership', async () => {
  const fixtures = {
    accounts: [{ id: 'account-uid', user_id: 'ucb-3' }, { id: 'account-profile', user_id: '3' }],
    transactions: [{ id: 'txn-uid', user_id: 'ucb-3' }, { id: 'txn-profile', user_id: '3' }],
    cards: [{ id: 'card-uid', user_id: 'ucb-3' }, { id: 'card-profile', user_id: '3' }],
    loans: [{ id: 'loan-uid', user_id: 'ucb-3' }, { id: 'loan-profile', user_id: '3' }],
    kyc: [{ id: 'kyc-uid', user_id: 'ucb-3' }, { id: 'kyc-profile', user_id: '3' }],
    bill_payments: [{ id: 'bill-uid', user_id: 'ucb-3' }, { id: 'bill-profile', user_id: '3' }]
  };
  const repository = {
    async list(collection, filters) {
      const ownerId = filters.find(filter => filter.field === 'user_id')?.value;
      return (fixtures[collection] || []).filter(record => record.user_id === ownerId);
    }
  };
  for (const collection of Object.keys(fixtures)) {
    const rows = await listByOwnerIds(repository, collection, ['ucb-3', '3']);
    assert.deepEqual(new Set(rows.map(row => row.id)), new Set(fixtures[collection].map(row => row.id)), collection);
    assert.ok(rows.every(row => ['ucb-3', '3'].includes(row.user_id)), collection);
  }
  assert.equal(recordHasOwnerId({ user_id: '4' }, ['ucb-3', '3']), false);
});

test('record ownership accepts only the explicitly derived owner IDs', () => {
  assert.equal(recordHasOwnerId({ user_id: '3' }, ['ucb-3', '3']), true);
  assert.equal(recordHasOwnerId({ user_id: 'other-profile' }, ['ucb-3', '3']), false);
});

test('linked account lookup withholds metadata unless the account belongs to an allowed owner ID', async () => {
  const { getOwnedAccount } = require('../services/owner-records');
  const repository = { async get(_collection, id) { return id === 'owned' ? { user_id: '3', account_number: '1234' } : { user_id: 'other', account_number: '9999' }; } };
  assert.equal((await getOwnedAccount(repository, 'owned', ['ucb-3', '3'])).account_number, '1234');
  assert.equal(await getOwnedAccount(repository, 'mismatched', ['ucb-3', '3']), null);
});
