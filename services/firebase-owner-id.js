'use strict';

const UID_FIELDS = ['firebase_uid', 'firebaseUid', 'uid', 'auth_uid'];

function firebaseUidAliases(profile) {
  if (!profile || typeof profile !== 'object') return [];
  return UID_FIELDS
    .map((field) => {
      if (!Object.prototype.hasOwnProperty.call(profile, field) || profile[field] === null || profile[field] === undefined) return '';
      if (typeof profile[field] !== 'string') return '\u0000invalid-uid-alias';
      return profile[field].trim() || '\u0000invalid-uid-alias';
    })
    .filter(Boolean);
}

function explicitFirebaseUid(profile) {
  const aliases = firebaseUidAliases(profile);
  if (!aliases.length || aliases.some((alias) => alias !== aliases[0])) return '';
  return aliases[0];
}

function hasConflictingFirebaseUid(profile, expectedUid) {
  const expected = String(expectedUid || '').trim();
  return firebaseUidAliases(profile).some((alias) => alias !== expected);
}

function hasConflictingFirebaseUidAliases(profile) {
  const aliases = firebaseUidAliases(profile);
  return aliases.includes('\u0000invalid-uid-alias') || new Set(aliases).size > 1;
}

function hasVerifiedFirebaseUidBinding(profile, expectedUid) {
  const uid = explicitFirebaseUid(profile);
  const expected = String(expectedUid || '').trim();
  const canonicalUid = typeof profile?.firebase_uid === 'string' ? profile.firebase_uid.trim() : '';
  const verifiedAt = profile?.firebase_uid_verified_at;
  return Boolean(uid && expected && uid === expected && canonicalUid === expected
    && typeof verifiedAt === 'string' && verifiedAt.trim());
}

/**
 * Return the Firebase UID that owns records for a profile document. Non-numeric
 * profile paths are UID-keyed directly. Numeric legacy profiles require a UID alias
 * and a verification timestamp written after a verified Firebase login.
 */
function firebaseOwnerUid(profile, profileDocumentId) {
  if (hasConflictingFirebaseUidAliases(profile)) return '';

  const documentId = String(profileDocumentId || (profile && (profile.profileId || profile.id)) || '').trim();
  if (!documentId) return '';
  const explicitUid = explicitFirebaseUid(profile);
  if (/^\d+$/.test(documentId)) {
    const expectedUid = `ucb-${documentId}`;
    if (hasVerifiedFirebaseUidBinding(profile, expectedUid)) return expectedUid;
    return hasVerifiedFirebaseUidBinding(profile, documentId) ? documentId : '';
  }
  if (explicitUid && explicitUid !== documentId) return '';
  return explicitUid || documentId;
}

function legacyProfileId(firebaseUid) {
  return typeof firebaseUid === 'string' ? (/^ucb-(\d+)$/.exec(firebaseUid)?.[1] || '') : '';
}

function ownerLookupIds(firebaseUid, profileDocumentId, verifiedProfile) {
  const uid = String(firebaseUid || '').trim();
  if (!uid) return [];
  const profileId = String(profileDocumentId || '').trim();
  return profileId && legacyProfileId(uid) === profileId && hasVerifiedFirebaseUidBinding(verifiedProfile, uid)
    ? [uid, profileId]
    : [uid];
}

module.exports = {
  explicitFirebaseUid,
  firebaseUidAliases,
  hasConflictingFirebaseUid,
  hasConflictingFirebaseUidAliases,
  hasVerifiedFirebaseUidBinding,
  firebaseOwnerUid,
  legacyProfileId,
  ownerLookupIds
};
