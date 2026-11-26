'use strict';

const { verifyFirebaseIdToken, refreshFirebaseToken } = require('../services/firebase-auth-rest');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { getAuthenticatedProfile, ensureCustomerUidBinding } = require('../services/authenticated-profile');

const defaultRepository = createFirestoreRepository();
const REFRESH_WINDOW_SECONDS = 180;

function applyVerifiedIdentity(session, profile, claims) {
  const uid = String(claims.uid);
  const profileId = String(profile.profileId || profile.id || uid);
  const emailVerified = claims.email_verified === true;
  const email = (emailVerified && claims.email) || profile.email || '';
  const user = { ...profile, id: profileId, profileId, uid, firebaseUid: uid, email, emailVerified };
  session.userId = uid;
  session.profileId = profileId;
  session.user = user;
  return user;
}

function createFirebaseAuthenticatedUser(options = {}) {
  const repository = options.repository || defaultRepository;
  const verifyIdToken = options.verifyFirebaseIdToken || verifyFirebaseIdToken;
  const refreshTokenFn = options.refreshFirebaseToken || refreshFirebaseToken;
  return async function firebaseAuthenticatedUser(req, res, next) {
  const token = req.session && req.session.firebaseIdToken;
  const refreshToken = req.session && req.session.firebaseRefreshToken;
  if (!token) {
    req.user = null;
    req.auth = null;
    return next();
  }

  try {
    let idToken = token;
    let claims;
    const { decodeJwt } = await import('jose');
    const decoded = decodeJwt(idToken);
    if (Number(decoded.exp || 0) <= Math.floor(Date.now() / 1000) + REFRESH_WINDOW_SECONDS) {
      if (!refreshToken) throw new Error('Firebase session expired.');
      const refreshed = await refreshTokenFn(refreshToken);
      idToken = refreshed.idToken;
      claims = await verifyIdToken(idToken);
      req.session.firebaseIdToken = idToken;
      req.session.firebaseRefreshToken = refreshed.refreshToken;
      req.session.firebaseExpiresAt = Date.now() + Number(refreshed.expiresIn || 3600) * 1000;
    } else {
      claims = await verifyIdToken(idToken);
    }

    const profile = await getAuthenticatedProfile(repository, claims.uid, claims.email, claims.email_verified === true);
    if (!profile || profile.disabled === true || profile.active === false || profile.is_frozen === true || Number(profile.is_frozen) === 1) {
      delete req.session.firebaseIdToken;
      delete req.session.firebaseRefreshToken;
      delete req.session.firebaseExpiresAt;
      req.session.error = 'Your account is unavailable. Please contact support.';
      req.user = null;
      req.auth = null;
      return next();
    }

    let authenticatedProfile = profile;
    const profileId = String(profile.profileId || profile.id || claims.uid);
    const adminIdentity = profile.role === 'admin' || profile.role === 'super_admin' || profile.is_admin === true || Number(profile.is_admin) === 1;
    if (!adminIdentity) authenticatedProfile = await ensureCustomerUidBinding(repository, profile, claims.uid, claims.email, claims.email_verified === true);

    req.auth = claims;
    // Compatibility fields are request-local projections; firebase-session strips them before cookie persistence.
    req.user = applyVerifiedIdentity(req.session, authenticatedProfile, claims);
    return next();
  } catch (error) {
    delete req.session.firebaseIdToken;
    delete req.session.firebaseRefreshToken;
    delete req.session.firebaseExpiresAt;
    req.session.error = 'Your session has expired. Please sign in again.';
    req.user = null;
    req.auth = null;
    return next();
  }
  };
}

const firebaseAuthenticatedUser = createFirebaseAuthenticatedUser();
module.exports = firebaseAuthenticatedUser;
module.exports.applyVerifiedIdentity = applyVerifiedIdentity;
module.exports.createFirebaseAuthenticatedUser = createFirebaseAuthenticatedUser;
