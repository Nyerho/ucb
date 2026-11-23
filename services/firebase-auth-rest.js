'use strict';

const { getRuntimeEnv } = require('../lib/runtime-env');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const IDENTITY_API = 'https://identitytoolkit.googleapis.com/v1';
const TOKEN_API = 'https://securetoken.googleapis.com/v1/token';
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let remoteJwks;

function required(name) {
  const value = getRuntimeEnv(name);
  if (!value) throw new Error(`Missing required runtime binding: ${name}`);
  return String(value);
}

function projectId() {
  return required('FIREBASE_PROJECT_ID');
}

function apiKey() {
  return required('FIREBASE_API_KEY');
}

function getRemoteJwks() {
  remoteJwks ||= createRemoteJWKSet(new URL(FIREBASE_CERTS_URL), { timeoutDuration: 5000, cooldownDuration: 30000 });
  return remoteJwks;
}

async function identityRequest(method, payload, idToken) {
  const response = await fetch(`${IDENTITY_API}/${method}?key=${encodeURIComponent(apiKey())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, ...(idToken ? { idToken } : {}) })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = body?.error?.message || 'AUTH_REQUEST_FAILED';
    const error = new Error(mapAuthError(code));
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return body;
}

function mapAuthError(code) {
  if (/EMAIL_EXISTS/.test(code)) return 'An account with this email already exists.';
  if (/INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS|USER_NOT_FOUND/.test(code)) return 'Invalid email or password.';
  if (/USER_DISABLED/.test(code)) return 'This account is disabled. Contact support.';
  if (/TOO_MANY_ATTEMPTS_TRY_LATER/.test(code)) return 'Too many attempts. Please try again later.';
  if (/WEAK_PASSWORD/.test(code)) return 'Choose a stronger password.';
  if (/OPERATION_NOT_ALLOWED/.test(code)) return 'Email and password sign-in is not enabled for this Firebase project.';
  if (/INVALID_ID_TOKEN|TOKEN_EXPIRED/.test(code)) return 'Your session has expired. Please sign in again.';
  return 'Authentication is temporarily unavailable. Please try again.';
}

async function signUpWithPassword(email, password, profile = {}) {
  const auth = await identityRequest('accounts:signUp', {
    email,
    password,
    returnSecureToken: true
  });
  if (profile.displayName) {
    try {
      await identityRequest('accounts:update', {
        displayName: profile.displayName,
        returnSecureToken: true
      }, auth.idToken);
    } catch (error) {
      try { await identityRequest('accounts:delete', {}, auth.idToken); } catch (_) { /* Preserve original failure. */ }
      throw error;
    }
  }
  return auth;
}

async function signInWithPassword(email, password) {
  return identityRequest('accounts:signInWithPassword', { email, password, returnSecureToken: true });
}

async function sendPasswordResetEmail(email) {
  return identityRequest('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email });
}

async function updatePassword(idToken, password) {
  return identityRequest('accounts:update', { password, returnSecureToken: true }, idToken);
}

async function updateFirebaseProfile(idToken, profile) {
  return identityRequest('accounts:update', { ...profile, returnSecureToken: true }, idToken);
}

async function deleteFirebaseUser(idToken) {
  return identityRequest('accounts:delete', {}, idToken);
}

async function refreshFirebaseToken(refreshToken) {
  const response = await fetch(`${TOKEN_API}?key=${encodeURIComponent(apiKey())}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.id_token || !body.refresh_token) {
    const code = body?.error?.message || 'TOKEN_REFRESH_FAILED';
    const error = new Error(mapAuthError(code));
    error.code = code;
    error.status = response.status;
    throw error;
  }
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in,
    localId: body.user_id
  };
}

async function verifyFirebaseIdToken(idToken) {
  const { payload, protectedHeader } = await jwtVerify(idToken, getRemoteJwks(), {
    issuer: `https://securetoken.google.com/${projectId()}`,
    audience: projectId(),
    algorithms: ['RS256'],
    clockTolerance: 5
  });
  if (!protectedHeader.kid || typeof payload.sub !== 'string' || !payload.sub.trim()) {
    throw new Error('Firebase ID token is missing a valid subject.');
  }
  if (!Number.isFinite(payload.auth_time) || payload.auth_time > Math.floor(Date.now() / 1000) + 5) {
    throw new Error('Firebase ID token has invalid authentication time.');
  }
  return { ...payload, uid: payload.sub };
}

module.exports = {
  signUpWithPassword,
  signInWithPassword,
  sendPasswordResetEmail,
  updatePassword,
  updateFirebaseProfile,
  deleteFirebaseUser,
  refreshFirebaseToken,
  verifyFirebaseIdToken,
  mapAuthError
};
