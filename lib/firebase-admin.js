const admin = require('firebase-admin');

function hasAdminCredentials() {
  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  );
}

function getFirebaseAdminApp() {
  if (!hasAdminCredentials()) {
    return null;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
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
  getFirebaseAdminApp,
  getFirestore
};
