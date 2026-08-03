const admin = require('firebase-admin');

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
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
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

  return admin.app();
}

function getFirestore() {
  const app = getFirebaseAdminApp();
  return app ? admin.firestore(app) : null;
}

module.exports = {
  admin,
  hasAdminCredentials,
  normalizePrivateKey,
  getFirebaseAdminApp,
  getFirestore
};
