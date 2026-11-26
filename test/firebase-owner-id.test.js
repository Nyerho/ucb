const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  explicitFirebaseUid,
  hasConflictingFirebaseUid,
  hasConflictingFirebaseUidAliases,
  hasVerifiedFirebaseUidBinding,
  firebaseOwnerUid,
  legacyProfileId,
  ownerLookupIds
} = require('../services/firebase-owner-id');

test('only returns an explicit UID when every stored UID alias agrees', () => {
  assert.equal(explicitFirebaseUid({ firebase_uid: 'ucb-3', firebaseUid: 'ucb-3', uid: 'ucb-3', auth_uid: 'ucb-3' }), 'ucb-3');
  assert.equal(explicitFirebaseUid({ firebase_uid: 'ucb-3', firebaseUid: 'other-uid' }), '');
  assert.equal(explicitFirebaseUid({ firebase_uid: 'ucb-3', auth_uid: 'other-uid' }), '');
  assert.equal(hasConflictingFirebaseUid({ firebase_uid: 'ucb-3', auth_uid: 'other-uid' }, 'ucb-3'), true);
  assert.equal(hasConflictingFirebaseUidAliases({ firebase_uid: 'ucb-3', firebaseUid: 'other-uid' }), true);
  assert.equal(hasConflictingFirebaseUid({ firebase_uid: 'ucb-3', firebaseUid: 'other-uid' }, 'ucb-3'), true);
  assert.equal(hasConflictingFirebaseUidAliases({ firebase_uid: 3 }), true);
});

test('numeric profile ownership requires an exact UID and a verified binding timestamp', () => {
  const profile = { firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z' };
  assert.equal(legacyProfileId('ucb-3'), '3');
  assert.equal(hasVerifiedFirebaseUidBinding(profile, 'ucb-3'), true);
  assert.equal(firebaseOwnerUid(profile, '3'), 'ucb-3');
  assert.equal(firebaseOwnerUid({ firebase_uid: 'ucb-3' }, '3'), '');
  assert.equal(firebaseOwnerUid({ firebase_uid: 'other-uid', firebase_uid_verified_at: 'yes' }, '3'), '');
  assert.equal(hasVerifiedFirebaseUidBinding({ auth_uid: 'ucb-3', firebase_uid_verified_at: 'yes' }, 'ucb-3'), false);
  assert.equal(firebaseOwnerUid({ auth_uid: 'ucb-3', firebase_uid_verified_at: 'yes' }, '3'), '');
  assert.equal(hasVerifiedFirebaseUidBinding({ firebase_uid: 3, firebase_uid_verified_at: true }, '3'), false);
  assert.equal(hasVerifiedFirebaseUidBinding({ firebase_uid: '3', firebase_uid_verified_at: true }, '3'), false);
  assert.equal(firebaseOwnerUid({ firebase_uid: 3, firebase_uid_verified_at: 'verified' }, '3'), '');
});

test('verified numeric Firebase UIDs remain direct owners rather than being mistaken for legacy IDs', () => {
  const directProfile = { firebase_uid: '12345', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z' };
  assert.equal(firebaseOwnerUid(directProfile, '12345'), '12345');
  assert.equal(firebaseOwnerUid({ firebase_uid: '12345' }, '12345'), '');
});

test('UID-keyed profile documents remain direct owners while conflicting aliases fail closed', () => {
  assert.equal(firebaseOwnerUid({ id: 'firebase-uid' }, 'firebase-uid'), 'firebase-uid');
  assert.equal(firebaseOwnerUid({ id: 'firebase-uid', firebase_uid: 'other-uid' }, 'firebase-uid'), '');
  assert.equal(firebaseOwnerUid({ firebase_uid: 'ucb-3', firebaseUid: 'other-uid' }, '3'), '');
  assert.equal(legacyProfileId('UCB-3'), '');
  assert.equal(legacyProfileId('ucb-3-extra'), '');
});

test('legacy owner lookup includes the profile ID only for the exact UID convention', () => {
  const boundProfile = { firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z' };
  assert.deepEqual(ownerLookupIds('ucb-3', '3', boundProfile), ['ucb-3', '3']);
  assert.deepEqual(ownerLookupIds('ucb-3', '3'), ['ucb-3'], 'legacy fallback needs a persisted canonical binding');
  assert.deepEqual(ownerLookupIds('ucb-3', '4', boundProfile), ['ucb-3']);
  assert.deepEqual(ownerLookupIds('12345', '12345'), ['12345']);
});
