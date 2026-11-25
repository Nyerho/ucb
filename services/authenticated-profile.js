'use strict';

function explicitAdminRole(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const role = String(profile.role || '').trim().toLowerCase();
  if (role === 'admin' || role === 'super_admin') return role;
  if (profile.is_super_admin === true) return 'super_admin';
  if (profile.is_admin === true || Number(profile.is_admin) === 1) return 'admin';
  return null;
}

function hasAdminPrivilege(profile) {
  return Boolean(explicitAdminRole(profile));
}

function demoteProfile(profile, uid) {
  if (!profile) return null;
  const result = { ...profile, id: uid, uid };
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

/**
 * Resolve an authenticated Firebase identity to its UCB profile. Admin records are
 * looked up only by the verified Firebase UID, never by a caller-supplied email or ID.
 */
async function getAuthenticatedProfile(repository, firebaseUid) {
  const uid = String(firebaseUid || '').trim();
  if (!uid) return null;

  const [userProfile, adminProfile] = await Promise.all([
    repository.get('users', uid),
    repository.get('admins', uid)
  ]);

  if (!adminProfile) {
    return userProfile ? { ...userProfile, id: uid, uid } : null;
  }

  const role = explicitAdminRole(adminProfile);
  if (adminProfile.active === true && role) {
    return {
      ...(userProfile || {}),
      ...adminProfile,
      id: uid,
      uid,
      role,
      is_admin: 1,
      is_super_admin: role === 'super_admin',
      is_frozen: isFrozen(userProfile) || isFrozen(adminProfile) ? 1 : 0,
      disabled: Boolean((userProfile && userProfile.disabled === true) || adminProfile.disabled === true),
      active: true
    };
  }

  // An inactive or malformed admins record must not inherit admin privileges from
  // a duplicate users record. If a separate customer profile exists, retain it as
  // a customer; otherwise deny the identity.
  return demoteProfile(userProfile, uid);
}

module.exports = { getAuthenticatedProfile, explicitAdminRole };
