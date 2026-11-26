'use strict';

const { explicitFirebaseUid, hasConflictingFirebaseUid, hasVerifiedFirebaseUidBinding, legacyProfileId } = require('./firebase-owner-id');

function explicitAdminRole(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const role = String(profile.role || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  return role === 'super_admin' || role === 'owner' ? 'super_admin' : null;
}

function hasAdminPrivilege(profile) {
  return Boolean(explicitAdminRole(profile)
    || (profile && (profile.is_super_admin === true || profile.is_admin === true || Number(profile.is_admin) === 1)));
}

function demoteProfile(profile, uid) {
  if (!profile) return null;
  const profileId = String(profile.id || uid);
  const result = { ...profile, id: profileId, profileId, uid, firebaseUid: uid, disabled: isDisabled(profile) };
  if (hasAdminPrivilege(profile)) {
    result.role = 'customer';
    result.is_admin = 0;
    result.is_super_admin = false;
  }
  return result;
}

function isFrozen(profile) {
  return Boolean(profile && (profile.is_frozen === true || Number(profile.is_frozen) === 1));
}

function isDisabled(profile) {
  return Boolean(profile && (profile.disabled === true || Number(profile.disabled) === 1));
}

function emailsMatch(left, right) {
  const normalizedLeft = String(left || '').trim().toLowerCase();
  const normalizedRight = String(right || '').trim().toLowerCase();
  return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
}

function hasVerifiedProfileEmail(profileEmail, authenticatedEmail, emailVerified) {
  return emailVerified === true && emailsMatch(profileEmail, authenticatedEmail);
}

function matchesAuthenticatedFirebaseUid(profile, firebaseUid) {
  const expectedUid = String(firebaseUid || '').trim();
  return Boolean(profile && expectedUid && String(profile.uid || '').trim() === expectedUid);
}

function numericUidEmailGate(profile, uid, authenticatedEmail, emailVerified) {
  if (!profile || !/^\d+$/.test(uid)) return true;
  return hasVerifiedFirebaseUidBinding(profile, uid)
    || hasVerifiedProfileEmail(profile.email, authenticatedEmail, emailVerified);
}

/**
 * Resolve an authenticated Firebase identity to its UCB profile. Admin records are
 * looked up only by Firebase UID. A legacy customer profile may be resolved from
 * the explicit ucb-<numeric document ID> UID convention only when its email matches
 * the authenticated Firebase email and it has no conflicting explicit Firebase UID.
 */
async function getAuthenticatedProfile(repository, firebaseUid, authenticatedEmail, emailVerified = false) {
  const uid = String(firebaseUid || '').trim();
  if (!uid) return null;

  const [userProfile, adminProfile] = await Promise.all([
    repository.get('users', uid),
    repository.get('admins', uid)
  ]);

  if (hasConflictingFirebaseUid(userProfile, uid) || hasConflictingFirebaseUid(adminProfile, uid)) return null;

  if (!adminProfile) {
    if (userProfile) {
      if (!numericUidEmailGate(userProfile, uid, authenticatedEmail, emailVerified)) return null;
      return demoteProfile(userProfile, uid);
    }
    const legacyId = /^ucb-(\d+)$/.exec(uid)?.[1];
    if (!legacyId) return null;
    const legacyProfile = await repository.get('users', legacyId);
    if (!legacyProfile || hasConflictingFirebaseUid(legacyProfile, uid)) return null;
    if (!hasVerifiedFirebaseUidBinding(legacyProfile, uid)
      && !hasVerifiedProfileEmail(legacyProfile.email, authenticatedEmail, emailVerified)) return null;
    return demoteProfile({ ...legacyProfile, id: legacyId }, uid);
  }

  const role = explicitAdminRole(adminProfile);
  if (adminProfile.active === true && role) {
    return {
      ...(userProfile || {}),
      ...adminProfile,
      id: uid,
      profileId: uid,
      uid,
      firebaseUid: uid,
      role,
      is_admin: 1,
      is_super_admin: role === 'super_admin',
      is_frozen: isFrozen(userProfile) || isFrozen(adminProfile) ? 1 : 0,
      disabled: isDisabled(userProfile) || isDisabled(adminProfile),
      active: true
    };
  }

  // An inactive or malformed admins record must not inherit admin privileges from
  // a duplicate users record. If a separate customer profile exists, retain it as
  // a customer; otherwise deny the identity.
  if (!numericUidEmailGate(userProfile, uid, authenticatedEmail, emailVerified)) return null;
  return demoteProfile(userProfile, uid);
}

function verifiedBindingError() {
  return Object.assign(new Error('Verified Firebase identity could not be safely linked to this UCB profile.'), { status: 409 });
}

async function writeVerifiedUidBinding(repository, uid, id, authenticatedEmail, emailVerified) {
  if (!repository || typeof repository.runTransaction !== 'function') throw new TypeError('A transactional Firestore repository is required.');

  const result = await repository.runTransaction(async (tx) => {
    const profile = await tx.get('users', id);
    if (!profile || hasConflictingFirebaseUid(profile, uid)) throw verifiedBindingError();
    const existingUid = explicitFirebaseUid(profile);
    if (existingUid && existingUid !== uid) throw verifiedBindingError();
    if (hasVerifiedFirebaseUidBinding(profile, uid)) return true;
    if (!hasVerifiedProfileEmail(profile.email, authenticatedEmail, emailVerified)) throw verifiedBindingError();
    const changes = {};
    if (String(profile.firebase_uid || '').trim() !== uid) changes.firebase_uid = uid;
    if (!profile.firebase_uid_verified_at) changes.firebase_uid_verified_at = new Date().toISOString();
    if (Object.keys(changes).length) tx.update('users', id, changes);
    return true;
  });
  if (!result || result.result !== true) throw verifiedBindingError();
  const persisted = await repository.get('users', id);
  if (!hasVerifiedFirebaseUidBinding(persisted, uid)) throw verifiedBindingError();
  return true;
}

async function bindVerifiedLegacyProfile(repository, firebaseUid, profileId, authenticatedEmail, emailVerified) {
  const uid = String(firebaseUid || '').trim();
  const id = String(profileId || '').trim();
  if (!legacyProfileId(uid) || legacyProfileId(uid) !== id) throw verifiedBindingError();
  return writeVerifiedUidBinding(repository, uid, id, authenticatedEmail, emailVerified);
}

async function bindVerifiedDirectNumericProfile(repository, firebaseUid, profileId, authenticatedEmail, emailVerified) {
  const uid = String(firebaseUid || '').trim();
  const id = String(profileId || '').trim();
  if (!/^\d+$/.test(uid) || uid !== id) throw verifiedBindingError();
  return writeVerifiedUidBinding(repository, uid, id, authenticatedEmail, emailVerified);
}

async function ensureCustomerUidBinding(repository, profile, firebaseUid, authenticatedEmail, emailVerified) {
  const uid = String(firebaseUid || '').trim();
  const profileId = String(profile && (profile.profileId || profile.id) || uid).trim();
  if (!uid || !profile) throw verifiedBindingError();

  if (profileId !== uid) {
    if (legacyProfileId(uid) !== profileId) throw verifiedBindingError();
    if (!hasVerifiedFirebaseUidBinding(profile, uid)) {
      await bindVerifiedLegacyProfile(repository, uid, profileId, authenticatedEmail, emailVerified);
    }
  } else if (/^\d+$/.test(uid) && !hasVerifiedFirebaseUidBinding(profile, uid)) {
    await bindVerifiedDirectNumericProfile(repository, uid, profileId, authenticatedEmail, emailVerified);
  } else {
    return { ...profile, id: profileId, profileId, uid, firebaseUid: uid };
  }

  const persisted = await repository.get('users', profileId);
  if (!hasVerifiedFirebaseUidBinding(persisted, uid)) throw verifiedBindingError();
  return { ...profile, ...persisted, id: profileId, profileId, uid, firebaseUid: uid };
}

module.exports = {
  getAuthenticatedProfile,
  bindVerifiedLegacyProfile,
  bindVerifiedDirectNumericProfile,
  ensureCustomerUidBinding,
  explicitAdminRole,
  emailsMatch,
  hasVerifiedProfileEmail,
  matchesAuthenticatedFirebaseUid
};
