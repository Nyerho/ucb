const admin = require('firebase-admin');
const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore: getFirestoreInstance } = require('firebase-admin/firestore');

let firebaseAdminUnavailableReason = null;

function hasAdminCredentials() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );
}

function normalizePrivateKey(value) {
  if (!value) {
    return '';
  }

  let normalized = String(value).trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  return normalized.replace(/\\n/g, '\n');
}

function getFirebaseAdminApp() {
  if (!hasAdminCredentials()) {
    return null;
  }

  if (firebaseAdminUnavailableReason) {
    return null;
  }

  try {
    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        })
      });
    }
  } catch (error) {
    firebaseAdminUnavailableReason = error;
    console.error('Firebase Admin initialization failed. Falling back without Firestore.', error);
    return null;
  }

  return getApp();
}

function getFirestore() {
  const app = getFirebaseAdminApp();
  return app ? getFirestoreInstance(app) : null;
}

module.exports = {
  admin,
  hasAdminCredentials,
  normalizePrivateKey,
  getFirebaseAdminApp,
  getFirestore
};
