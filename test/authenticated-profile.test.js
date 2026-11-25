const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getAuthenticatedProfile } = require('../services/authenticated-profile');
const { isAdminUser } = require('../middleware/auth');

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

test('requires active true and an explicit admin role or admin flag to accept an admins record', async () => {
  const uid = 'firebase-uid-4';
  const { repository } = repositoryFixture({
    [`admins/${uid}`]: { active: true, email: 'person@example.test' }
  });

  const profile = await getAuthenticatedProfile(repository, uid);

  assert.equal(profile, null);
});
