const admin = require('firebase-admin');
const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore: getFirestoreInstance } = require('firebase-admin/firestore');

const DEFAULT_FIREBASE_PROJECT_ID = 'unitedcb-4845b';
const FIREBASE_INIT_RETRY_INTERVAL_MS = 5 * 60 * 1000;

let firebaseAdminUnavailableReason = null;
let lastDiagnosticLog = 0;

function getResolvedProjectId() {
  return process.env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;
}

function hasAdminCredentials() {
  const projectId = process.env.FIREBASE_PROJECT_ID || DEFAULT_FIREBASE_PROJECT_ID;
  return Boolean(
    projectId &&
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

function getFirestoreAdminDiagnostics() {
  const projectIdSet = Boolean(process.env.FIREBASE_PROJECT_ID);
  const projectIdResolved = getResolvedProjectId();
  const clientEmailSet = Boolean(process.env.FIREBASE_CLIENT_EMAIL);
  const privateKeySet = Boolean(process.env.FIREBASE_PRIVATE_KEY);
  const privateKeyLength = process.env.FIREBASE_PRIVATE_KEY
    ? String(process.env.FIREBASE_PRIVATE_KEY).length
    : 0;
  const hasCreds = hasAdminCredentials();
  const initError = firebaseAdminUnavailableReason
    ? String(firebaseAdminUnavailableReason)
    : null;

  return {
    projectIdSet,
    projectIdResolved,
    clientEmailSet,
    privateKeySet,
    privateKeyLength,
    hasAdminCredentials: hasCreds,
    initError,
    appCount: getApps().length
  };
}

function logFirestoreDiagnostics(force = false) {
  const now = Date.now();
  if (!force && now - lastDiagnosticLog < 30000) {
    return;
  }
  lastDiagnosticLog = now;

  const diag = getFirestoreAdminDiagnostics();

  if (diag.hasAdminCredentials && !diag.initError && diag.appCount > 0) {
    return;
  }

  const lines = [
    '',
    '============================================================',
    '  FIREBASE ADMIN / FIRESTORE DIAGNOSTICS',
    '============================================================',
    `  FIREBASE_PROJECT_ID set:       ${diag.projectIdSet ? 'YES' : 'NO (using default)'}`,
    `  Resolved project ID:           ${diag.projectIdResolved}`,
    `  FIREBASE_CLIENT_EMAIL set:     ${diag.clientEmailSet ? 'YES' : 'NO (CRITICAL - required)'}`,
    `  FIREBASE_PRIVATE_KEY set:      ${diag.privateKeySet ? `YES (length: ${diag.privateKeyLength})` : 'NO (CRITICAL - required)'}`,
    `  hasAdminCredentials():         ${diag.hasAdminCredentials ? 'PASS' : 'FAIL'}`,
    diag.initError ? `  Init error:                    ${diag.initError}` : '',
    diag.hasAdminCredentials && !diag.initError && diag.appCount === 0
      ? '  NOTE: Credentials present but app not initialized yet.'
      : '',
    '============================================================',
    '  If Firestore sync is not working:',
    '  1. Copy service account JSON from Firebase Console ->',
    '     Project Settings -> Service Accounts -> Generate Key',
    '  2. Set these env vars in your .env file:',
    '     FIREBASE_PROJECT_ID=<project_id>',
    '     FIREBASE_CLIENT_EMAIL=<client_email>',
    '     FIREBASE_PRIVATE_KEY="<full private key with BEGIN/END>"',
    '============================================================',
    ''
  ].filter(Boolean);

  console.warn(lines.join('\n'));
}

function getFirebaseAdminApp() {
  if (!hasAdminCredentials()) {
    logFirestoreDiagnostics();
    return null;
  }

  if (firebaseAdminUnavailableReason) {
    const now = Date.now();
    const errorTs = Number(firebaseAdminUnavailableReason.timestamp) || 0;
    const errorAge = now - errorTs;
    if (errorAge < FIREBASE_INIT_RETRY_INTERVAL_MS) {
      logFirestoreDiagnostics();
      return null;
    }
    console.warn(
      `[firebase-admin] Previous init error was ${Math.round(errorAge / 1000)}s ago. ` +
      `Clearing cached failure and retrying initialization...`
    );
    firebaseAdminUnavailableReason = null;
  }

  try {
    if (!getApps().length) {
      const projectId = getResolvedProjectId();
      initializeApp({
        credential: cert({
          projectId: projectId,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY)
        })
      });
      console.log(`[firebase-admin] Initialized with project "${projectId}"`);
    }
  } catch (error) {
    error.timestamp = Date.now();
    firebaseAdminUnavailableReason = error;
    console.error('Firebase Admin initialization failed. Falling back without Firestore.', error);
    logFirestoreDiagnostics(true);
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
  getFirestore,
  getFirestoreAdminDiagnostics,
  logFirestoreDiagnostics,
  getResolvedProjectId
};
