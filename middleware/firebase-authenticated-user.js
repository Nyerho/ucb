'use strict';

const { verifyFirebaseIdToken, refreshFirebaseToken } = require('../services/firebase-auth-rest');
const { createFirestoreRepository } = require('../services/firestore-rest');

const repository = createFirestoreRepository();
const REFRESH_WINDOW_SECONDS = 180;

module.exports = async function firebaseAuthenticatedUser(req, res, next) {
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
      const refreshed = await refreshFirebaseToken(refreshToken);
      idToken = refreshed.idToken;
      claims = await verifyFirebaseIdToken(idToken);
      req.session.firebaseIdToken = idToken;
      req.session.firebaseRefreshToken = refreshed.refreshToken;
      req.session.firebaseExpiresAt = Date.now() + Number(refreshed.expiresIn || 3600) * 1000;
    } else {
      claims = await verifyFirebaseIdToken(idToken);
    }

    const profile = await repository.get('users', claims.uid);
    if (!profile || profile.disabled === true || Number(profile.is_frozen) === 1) {
      delete req.session.firebaseIdToken;
      delete req.session.firebaseRefreshToken;
      delete req.session.firebaseExpiresAt;
      req.session.error = 'Your account is unavailable. Please contact support.';
      req.user = null;
      req.auth = null;
      return next();
    }

    req.auth = claims;
    req.user = { ...profile, id: claims.uid, uid: claims.uid, email: claims.email || profile.email };
    // Compatibility fields are request-local projections; firebase-session strips them before cookie persistence.
    req.session.userId = claims.uid;
    req.session.user = req.user;
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
