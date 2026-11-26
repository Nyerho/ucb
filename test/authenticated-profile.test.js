const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAuthenticatedProfile, bindVerifiedLegacyProfile, bindVerifiedDirectNumericProfile, ensureCustomerUidBinding, emailsMatch, hasVerifiedProfileEmail, matchesAuthenticatedFirebaseUid } = require('../services/authenticated-profile');
const { isAdminUser } = require('../middleware/auth');
const { applyVerifiedIdentity, createFirebaseAuthenticatedUser } = require('../middleware/firebase-authenticated-user');
const { matchingAuthenticatedUser } = require('../services/email');

function repositoryFixture(records) {
  const calls = [];
  return {
    calls,
    repository: {
      async get(collection, id) {
        calls.push([collection, id]);
        return records[`${collection}/${id}`] || null;
      }
    }
  };
}

test('resolves an active super_admin only from the admins document keyed by Firebase UID', async () => {
  const uid = 'firebase-uid-1';
  const { repository, calls } = repositoryFixture({
    [`admins/${uid}`]: {
      email: 'admin@example.test',
      first_name: 'System',
      last_name: 'Administrator',
      active: true,
      is_super_admin: true,
      role: 'super_admin'
    }
  });

  const profile = await getAuthenticatedProfile(repository, uid);

  assert.deepEqual(calls, [['users', uid], ['admins', uid]]);
  assert.equal(profile.id, uid);
  assert.equal(profile.uid, uid);
  assert.equal(profile.role, 'super_admin');
  assert.equal(profile.is_admin, 1);
  assert.equal(profile.is_super_admin, true);
  assert.equal(isAdminUser(profile), true);
});

test('does not grant privileges from an inactive admins record, including through a duplicate user profile', async () => {
  const uid = 'firebase-uid-2';
  const { repository } = repositoryFixture({
    [`users/${uid}`]: { first_name: 'Existing', role: 'super_admin', is_admin: 1 },
    [`admins/${uid}`]: { active: false, role: 'super_admin', is_super_admin: true }
  });

  const profile = await getAuthenticatedProfile(repository, uid);

  assert.equal(profile.role, 'customer');
  assert.equal(profile.is_admin, 0);
  assert.equal(profile.is_super_admin, false);
  assert.equal(isAdminUser(profile), false);
});

test('preserves ordinary Firebase user profiles and rejects identities with no matching profile', async () => {
  const uid = 'firebase-uid-3';
  const { repository } = repositoryFixture({
    [`users/${uid}`]: { email: 'customer@example.test', role: 'customer', is_admin: 0 }
  });

  const profile = await getAuthenticatedProfile(repository, uid);
  const missing = await getAuthenticatedProfile(repository, 'firebase-uid-missing');

  assert.equal(profile.id, uid);
  assert.equal(profile.role, 'customer');
  assert.equal(isAdminUser(profile), false);
  assert.equal(missing, null);
});

test('rejects a directly UID-keyed profile when any stored UID alias conflicts with the authenticated UID', async () => {
  const { repository } = repositoryFixture({
    'users/direct-uid': { firebase_uid: 'direct-uid', firebaseUid: 'other-uid', uid: 'direct-uid', role: 'customer' }
  });
  assert.equal(await getAuthenticatedProfile(repository, 'direct-uid'), null);
});

test('resolves a numeric Firebase UID from its direct profile path before any legacy fallback', async () => {
  const { repository, calls } = repositoryFixture({
    'users/12345': { email: 'customer@example.test', role: 'customer', is_admin: 0 },
    'users/2345': { email: 'other@example.test', role: 'customer', is_admin: 0 }
  });
  const profile = await getAuthenticatedProfile(repository, '12345', 'customer@example.test', true);
  assert.deepEqual(calls, [['users', '12345'], ['admins', '12345']]);
  assert.equal(profile.id, '12345');
  assert.equal(profile.profileId, '12345');
  assert.equal(profile.uid, '12345');
});

test('rejects an unbound direct numeric UID profile when the authenticated verified email does not match', async () => {
  const { repository } = repositoryFixture({
    'users/12345': { email: 'profile@example.test', role: 'customer', is_admin: 0 }
  });
  assert.equal(await getAuthenticatedProfile(repository, '12345', 'different@example.test', true), null);
  assert.equal(await getAuthenticatedProfile(repository, '12345', 'profile@example.test', false), null);
});

test('numeric UID email gate still applies when an inactive or malformed admins record exists', async () => {
  const user = { email: 'profile@example.test', role: 'customer', is_admin: 0 };
  for (const [uid, admin] of [
    ['12345', { active: false, role: 'admin' }],
    ['23456', { active: true, is_admin: 1 }],
    ['34567', { active: true, role: 'auditor' }]
  ]) {
    const { repository } = repositoryFixture({ [`users/${uid}`]: user, [`admins/${uid}`]: admin });
    assert.equal(await getAuthenticatedProfile(repository, uid, 'different@example.test', true), null, `${uid} must fail the email gate`);
  }
  const { repository } = repositoryFixture({
    'users/45678': user,
    'admins/45678': { active: false, role: 'admin' }
  });
  const matchingCustomer = await getAuthenticatedProfile(repository, '45678', 'profile@example.test', true);
  assert.equal(matchingCustomer.id, '45678');
  assert.equal(matchingCustomer.role, 'customer');
});

test('requires active true and an explicit permitted role to accept an admins record', async () => {
  for (const [uid, admin] of [
    ['missing-role', { active: true, email: 'person@example.test' }],
    ['flag-only', { active: true, is_admin: 1, email: 'person@example.test' }],
    ['unsupported-role', { active: true, role: 'auditor', email: 'person@example.test' }]
  ]) {
    const { repository } = repositoryFixture({ [`admins/${uid}`]: admin });
    assert.equal(await getAuthenticatedProfile(repository, uid), null, `${uid} must not be authorized`);
  }
});

test('accepts an explicit active owner role as a super administrator for compatibility', async () => {
  const { repository } = repositoryFixture({
    'admins/owner-uid': { active: true, role: 'owner', email: 'owner@example.test' }
  });
  const profile = await getAuthenticatedProfile(repository, 'owner-uid');
  assert.equal(profile.role, 'super_admin');
  assert.equal(profile.is_super_admin, true);
});

test('normalizes integer disabled flags before downstream customer and administrator access guards', async () => {
  const { repository } = repositoryFixture({
    'users/disabled-customer': { email: 'customer@example.test', role: 'customer', disabled: 1 },
    'admins/disabled-admin': { active: true, role: 'admin', disabled: 1 }
  });
  const disabledCustomer = await getAuthenticatedProfile(repository, 'disabled-customer');
  const disabledAdmin = await getAuthenticatedProfile(repository, 'disabled-admin');
  assert.equal(disabledCustomer.disabled, true);
  assert.equal(disabledAdmin.active, true);
  assert.equal(disabledAdmin.role, 'admin');
  assert.equal(disabledAdmin.disabled, true);
});

test('resolves a legacy numeric profile only through the matching ucb-UID convention and authenticated email', async () => {
  const uid = 'ucb-3';
  const { repository, calls } = repositoryFixture({
    'users/3': { email: 'customer@example.test', first_name: 'Customer', role: 'customer', is_admin: 0 }
  });

  const profile = await getAuthenticatedProfile(repository, uid, 'Customer@Example.Test', true);

  assert.deepEqual(calls, [['users', uid], ['admins', uid], ['users', '3']]);
  assert.equal(profile.id, '3');
  assert.equal(profile.profileId, '3');
  assert.equal(profile.uid, uid);
  assert.equal(profile.firebaseUid, uid);
  assert.equal(profile.role, 'customer');
  assert.equal(isAdminUser(profile), false);
});

test('keeps Firebase UID as the ownership identity while projecting the numeric profile document ID separately', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'customer@example.test', first_name: 'Customer', role: 'customer', is_admin: 0 }
  });
  const profile = await getAuthenticatedProfile(repository, 'ucb-3', 'customer@example.test', true);
  const session = {};
  const requestUser = applyVerifiedIdentity(session, profile, { uid: 'ucb-3', email: 'customer@example.test' });

  assert.equal(session.userId, 'ucb-3');
  assert.equal(session.profileId, '3');
  assert.equal(requestUser.id, '3');
  assert.equal(requestUser.profileId, '3');
  assert.equal(requestUser.uid, 'ucb-3');
});

test('account ownership identity checks use Firebase UID, not a numeric profile document ID', () => {
  assert.equal(matchesAuthenticatedFirebaseUid({ id: '3', profileId: '3', uid: 'ucb-3' }, 'ucb-3'), true);
  assert.equal(matchesAuthenticatedFirebaseUid({ id: '3', uid: 'another-uid' }, 'ucb-3'), false);
  assert.equal(matchesAuthenticatedFirebaseUid({ id: 'ucb-3' }, 'ucb-3'), false);
});

test('does not replace a stored profile email with an unverified Firebase email claim', () => {
  const profile = { id: '3', profileId: '3', email: 'stored@example.test' };
  const user = applyVerifiedIdentity({}, profile, { uid: 'ucb-3', email: 'unverified@example.test', email_verified: false });
  assert.equal(user.email, 'stored@example.test');
  assert.equal(user.emailVerified, false);
  assert.equal(matchingAuthenticatedUser('ucb-3', user), null);
});

test('uses case-insensitive Firebase email matching and only associates email alerts with the verified transaction owner', () => {
  const user = { uid: 'ucb-3', firebaseUid: 'ucb-3', email: 'customer@example.test', emailVerified: true };
  assert.equal(emailsMatch(' Customer@Example.Test ', user.email), true);
  assert.equal(emailsMatch('other@example.test', user.email), false);
  assert.equal(matchingAuthenticatedUser('ucb-3', user), user);
  assert.equal(matchingAuthenticatedUser('another-uid', user), null);
  assert.equal(matchingAuthenticatedUser('ucb-3', { ...user, emailVerified: false }), null);
  assert.equal(matchingAuthenticatedUser('ucb-3', { uid: 'ucb-3' }), null);
});

test('only permits a login notice to the profile email when it matches the verified Firebase email', () => {
  assert.equal(hasVerifiedProfileEmail('Customer@example.test', 'customer@example.test', true), true);
  assert.equal(hasVerifiedProfileEmail('customer@example.test', 'other@example.test', true), false);
  assert.equal(hasVerifiedProfileEmail('customer@example.test', 'customer@example.test', false), false);
  assert.equal(hasVerifiedProfileEmail('', 'customer@example.test', true), false);
});

test('does not resolve a numeric legacy profile when the Firebase email is not verified', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'customer@example.test', role: 'customer' }
  });

  assert.equal(await getAuthenticatedProfile(repository, 'ucb-3', 'customer@example.test', false), null);
});

test('rejects a legacy numeric profile when its email does not match the authenticated Firebase identity', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'different@example.test', role: 'customer' }
  });

  assert.equal(await getAuthenticatedProfile(repository, 'ucb-3', 'customer@example.test', true), null);
});

test('a canonical verified UID binding remains valid after the Firebase email claim changes or is unverified', async () => {
  const { repository } = repositoryFixture({
    'users/3': {
      email: 'old@example.test',
      firebase_uid: 'ucb-3',
      firebase_uid_verified_at: '2026-11-25T10:00:00.000Z',
      role: 'customer'
    }
  });
  const changedEmail = await getAuthenticatedProfile(repository, 'ucb-3', 'new@example.test', true);
  const unverifiedEmail = await getAuthenticatedProfile(repository, 'ucb-3', 'new@example.test', false);
  assert.equal(changedEmail.profileId, '3');
  assert.equal(unverifiedEmail.profileId, '3');
});

test('rejects a legacy numeric profile when it explicitly links to a different Firebase UID', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'customer@example.test', firebase_uid: 'other-uid', role: 'customer' }
  });

  assert.equal(await getAuthenticatedProfile(repository, 'ucb-3', 'customer@example.test', true), null);
});

test('rejects a legacy profile when any UID alias conflicts even if another alias matches', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'customer@example.test', firebase_uid: 'ucb-3', firebaseUid: 'other-uid', uid: 'ucb-3', role: 'customer' }
  });
  assert.equal(await getAuthenticatedProfile(repository, 'ucb-3', 'customer@example.test', true), null);
});

test('rejects auth_uid ownership alias conflicts on legacy profiles', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'customer@example.test', auth_uid: 'other-uid', role: 'customer' }
  });
  assert.equal(await getAuthenticatedProfile(repository, 'ucb-3', 'customer@example.test', true), null);
});

test('binds an existing legacy profile to the UID only inside a matching verified-login transaction', async () => {
  let profile = { email: 'Customer@example.test', first_name: 'Customer' };
  const writes = [];
  const repository = {
    async runTransaction(callback) {
      const result = await callback({
        async get(collection, id) {
          assert.equal(collection, 'users');
          assert.equal(id, '3');
          return structuredClone(profile);
        },
        update(collection, id, changes) {
          writes.push({ collection, id, changes: structuredClone(changes) });
          profile = { ...profile, ...changes };
        }
      });
      return { result, commitTime: 'test' };
    },
    async get(collection, id) { assert.equal(collection, 'users'); assert.equal(id, '3'); return structuredClone(profile); }
  };

  assert.equal(await bindVerifiedLegacyProfile(repository, 'ucb-3', '3', 'customer@example.test', true), true);
  assert.equal(profile.firebase_uid, 'ucb-3');
  assert.ok(profile.firebase_uid_verified_at);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].collection, 'users');
  assert.equal(writes[0].id, '3');
  assert.equal(writes[0].changes.firebase_uid, 'ucb-3');
});

test('promotes a matching legacy auth_uid to canonical firebase_uid during verified binding', async () => {
  let profile = { email: 'customer@example.test', auth_uid: 'ucb-3' };
  const repository = {
    async runTransaction(callback) {
      const result = await callback({
        async get() { return structuredClone(profile); },
        update(_collection, _id, changes) { profile = { ...profile, ...changes }; }
      });
      return { result, commitTime: 'test' };
    },
    async get(_collection, _id) { return structuredClone(profile); }
  };
  assert.equal(await bindVerifiedLegacyProfile(repository, 'ucb-3', '3', 'customer@example.test', true), true);
  assert.equal(profile.firebase_uid, 'ucb-3');
  assert.ok(profile.firebase_uid_verified_at);
});

test('binds a direct numeric Firebase UID profile without reclassifying its path as a legacy ucb UID', async () => {
  let profile = { email: 'customer@example.test', role: 'customer' };
  const repository = {
    async runTransaction(callback) {
      const result = await callback({
        async get(collection, id) {
          assert.equal(collection, 'users');
          assert.equal(id, '12345');
          return structuredClone(profile);
        },
        update(_collection, _id, changes) { profile = { ...profile, ...changes }; }
      });
      return { result, commitTime: 'test' };
    },
    async get(_collection, _id) { return structuredClone(profile); }
  };
  assert.equal(await bindVerifiedDirectNumericProfile(repository, '12345', '12345', 'customer@example.test', true), true);
  assert.equal(profile.firebase_uid, '12345');
  assert.ok(profile.firebase_uid_verified_at);
});

test('refuses to bind an unverified, mismatched, or conflicting legacy profile', async () => {
  const cases = [
    { email: 'customer@example.test' },
    { email: 'other@example.test' },
    { email: 'customer@example.test', firebase_uid: 'ucb-3', firebaseUid: 'other-uid' }
  ];
  for (const [index, initial] of cases.entries()) {
    const writes = [];
    const repository = {
      async runTransaction(callback) {
        const result = await callback({
          async get() { return structuredClone(initial); },
          update(_collection, _id, changes) { writes.push(changes); }
        });
        return { result, commitTime: 'test' };
      }
    };
    await assert.rejects(
      () => bindVerifiedLegacyProfile(repository, 'ucb-3', '3', 'customer@example.test', index !== 0),
      /could not be safely linked/
    );
    assert.deepEqual(writes, []);
  }
});

test('does not guess a legacy profile ID for a Firebase UID outside the strict numeric convention', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'customer@example.test', role: 'customer' }
  });

  assert.equal(await getAuthenticatedProfile(repository, 'other-uid', 'customer@example.test'), null);
});

test('customer authentication fails closed when the canonical binding transaction cannot persist', async () => {
  const profile = { id: '3', profileId: '3', uid: 'ucb-3', email: 'customer@example.test', role: 'customer' };
  const repository = {
    async runTransaction() { throw new Error('Firestore transaction unavailable'); },
    async get() { return { email: 'customer@example.test', role: 'customer' }; }
  };
  await assert.rejects(
    () => ensureCustomerUidBinding(repository, profile, 'ucb-3', 'customer@example.test', true),
    /Firestore transaction unavailable/
  );
});

test('Firebase request middleware clears authentication when the legacy binding transaction fails', async () => {
  const middleware = createFirebaseAuthenticatedUser({
    repository: {
      async get(collection, id) {
        if (collection === 'users' && id === '3') return { email: 'customer@example.test', role: 'customer' };
        return null;
      },
      async runTransaction() { throw new Error('Firestore transaction unavailable'); }
    },
    async verifyFirebaseIdToken() {
      return { uid: 'ucb-3', email: 'customer@example.test', email_verified: true };
    }
  });
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const req = { session: { firebaseIdToken: `e30.${payload}.signature`, firebaseRefreshToken: 'refresh-token' } };
  let continued = false;
  await middleware(req, {}, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(req.auth, null);
  assert.equal(req.user, null);
  assert.equal(req.session.firebaseIdToken, undefined);
  assert.equal(req.session.firebaseRefreshToken, undefined);
  assert.match(req.session.error, /session has expired/i);
});

test('does not use email fallback to grant access when an administrator record is not UID-keyed', async () => {
  const { repository } = repositoryFixture({
    'users/3': { email: 'admin@example.test', role: 'super_admin', is_admin: 1 },
    'admins/some-other-uid': { email: 'admin@example.test', active: true, role: 'super_admin' }
  });

  const profile = await getAuthenticatedProfile(repository, 'ucb-3', 'admin@example.test', true);

  assert.equal(profile.role, 'customer');
  assert.equal(profile.profileId, '3');
  assert.equal(isAdminUser(profile), false);
});
