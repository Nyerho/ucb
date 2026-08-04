const admin = require('firebase-admin');
const { cert, getApp, getApps, initializeApp } = require('firebase-admin/app');
const { getFirestore: getFirestoreInstance } = require('firebase-admin/firestore');
const { getAuth: getAuthInstance } = require('firebase-admin/auth');
const crypto = require('crypto');

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

  normalized = normalized.trim();

  normalized = normalized
    .replace(/\\r\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\n/g, '\n');

  normalized = normalized
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  const hasBeginMarker = normalized.includes('-----BEGIN PRIVATE KEY-----');
  const hasEndMarker = normalized.includes('-----END PRIVATE KEY-----');
  const beginIdx = normalized.indexOf('-----BEGIN PRIVATE KEY-----');
  const endIdx = normalized.indexOf('-----END PRIVATE KEY-----');

  if (hasBeginMarker && hasEndMarker && beginIdx < endIdx) {
    const header = '-----BEGIN PRIVATE KEY-----';
    const footer = '-----END PRIVATE KEY-----';
    const afterHeader = beginIdx + header.length;
    const bodyRaw = normalized.slice(afterHeader, endIdx);
    const body = bodyRaw
      .replace(/\s+/g, '')
      .replace(/(.{64})/g, '$1\n')
      .replace(/\n$/g, '');
    normalized = `${header}\n${body}\n${footer}\n`;
  }

  return normalized;
}

function validatePrivateKey(rawValue) {
  if (!rawValue) {
    return { valid: false, reason: 'not set' };
  }
  const normalized = normalizePrivateKey(rawValue);
  if (!normalized || normalized.length < 100) {
    return { valid: false, reason: `too short (${normalized.length} chars after normalize)` };
  }
  const hasBegin = normalized.includes('-----BEGIN PRIVATE KEY-----');
  const hasEnd = normalized.includes('-----END PRIVATE KEY-----');
  if (!hasBegin) {
    return { valid: false, reason: 'missing BEGIN PRIVATE KEY marker (key may be malformed or \\n not expanded in env)' };
  }
  if (!hasEnd) {
    return { valid: false, reason: 'missing END PRIVATE KEY marker' };
  }
  const bodyMatch = normalized.match(/-----BEGIN PRIVATE KEY-----\n([\s\S]+?)\n-----END PRIVATE KEY-----/);
  if (!bodyMatch) {
    return { valid: false, reason: 'could not extract key body between markers' };
  }
  const base64Body = bodyMatch[1].replace(/\s+/g, '');
  if (base64Body.length < 1000) {
    return { valid: false, reason: `base64 body too short (${base64Body.length} chars - expected ~1700 for RSA-2048)` };
  }
  const b64valid = /^[A-Za-z0-9+/=]+$/.test(base64Body);
  if (!b64valid) {
    return { valid: false, reason: 'base64 body contains invalid characters (multi-line env var likely mangled)' };
  }
  return { valid: true, reason: 'ok', normalizedLength: normalized.length, bodyBase64Length: base64Body.length };
}

function getFirestoreAdminDiagnostics() {
  const projectIdSet = Boolean(process.env.FIREBASE_PROJECT_ID);
  const projectIdResolved = getResolvedProjectId();
  const clientEmailSet = Boolean(process.env.FIREBASE_CLIENT_EMAIL);
  const clientEmailValue = process.env.FIREBASE_CLIENT_EMAIL || '';
  const clientEmailLooksValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clientEmailValue.trim());
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  const privateKeySet = Boolean(privateKeyRaw);
  const privateKeyRawLength = privateKeyRaw ? String(privateKeyRaw).length : 0;
  const keyValidation = validatePrivateKey(privateKeyRaw);
  const hasCreds = hasAdminCredentials();
  const initError = firebaseAdminUnavailableReason
    ? String(firebaseAdminUnavailableReason)
    : null;
  const isVercel = Boolean(process.env.VERCEL);
  const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

  return {
    projectIdSet,
    projectIdResolved,
    clientEmailSet,
    clientEmailLooksValid,
    clientEmailValue: clientEmailValue ? `[REDACTED length=${clientEmailValue.length}]` : '(empty)',
    privateKeySet,
    privateKeyRawLength,
    privateKeyValid: keyValidation.valid,
    privateKeyReason: keyValidation.reason,
    hasAdminCredentials: hasCreds,
    initError,
    appCount: getApps().length,
    isServerless: isVercel || isLambda,
    runtime: isVercel ? 'vercel' : (isLambda ? 'aws-lambda' : 'local'),
    normalizedPrivateKeyLength: keyValidation.normalizedLength || 0
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

  const onVercel = diag.runtime === 'vercel';

  const lines = [
    '',
    '============================================================',
    `  FIREBASE ADMIN / FIRESTORE DIAGNOSTICS  [runtime: ${diag.runtime}]`,
    '============================================================',
    `  FIREBASE_PROJECT_ID set:       ${diag.projectIdSet ? 'YES' : 'NO (using default)'}`,
    `  Resolved project ID:           ${diag.projectIdResolved}`,
    `  FIREBASE_CLIENT_EMAIL set:     ${diag.clientEmailSet ? (diag.clientEmailLooksValid ? 'YES (valid)' : 'YES (but FORMAT looks INVALID)') : 'NO (CRITICAL - required)'}`,
    `  FIREBASE_CLIENT_EMAIL value:   ${diag.clientEmailValue}`,
    `  FIREBASE_PRIVATE_KEY set:      ${diag.privateKeySet ? `YES (raw length=${diag.privateKeyRawLength}, normalized=${diag.normalizedPrivateKeyLength})` : 'NO (CRITICAL - required)'}`,
    `  Private key VALID:             ${diag.privateKeyValid ? 'YES' : 'NO - ' + diag.privateKeyReason}`,
    `  hasAdminCredentials():         ${diag.hasAdminCredentials ? 'PASS' : 'FAIL'}`,
    diag.initError ? `  Init error:                    ${diag.initError.split('\n')[0]}` : '',
    diag.hasAdminCredentials && !diag.initError && diag.appCount === 0
      ? '  NOTE: Credentials present but app not initialized yet.'
      : '',
    '============================================================',
    onVercel
      ? [
          '  VERCEL DEPLOYMENT - Configure these in Project Settings:',
          '  Vercel Dashboard → Settings → Environment Variables:',
          '',
          '  1. FIREBASE_CLIENT_EMAIL',
          '     e.g.: firebase-adminsdk-XXX@project-id.iam.gserviceaccount.com',
          '',
          '  2. FIREBASE_PRIVATE_KEY  (CRITICAL - READ BELOW!)',
          '     MULTI-LINE ENV VAR PASTE INSTRUCTIONS:',
          '     - Open the service-account JSON file you downloaded',
          '     - Find the "private_key" field (it has \\n inside)',
          '     - COPY the full value between the quotes exactly,',
          '       INCLUDING the -----BEGIN and -----END lines,',
          '       WITH real line breaks (NOT literal \\n characters)',
          '     - In Vercel env var input, PASTE it DIRECTLY; do NOT',
          '       wrap it in extra quotes! Vercel preserves newlines.',
          '     - If still broken, set FIREBASE_PROJECT_ID explicitly',
          '       as well (it has the same value as your project ID).',
          '',
          '     After setting env vars, REDEPLOY the project!',
          '     (Settings → Environment Variables only apply to NEW deployments)',
          '',
          '  3. Optional: FIREBASE_PROJECT_ID (if not using default)'
        ].join('\n')
      : [
          '  If Firestore sync is not working:',
          '  1. Copy service account JSON from Firebase Console ->',
          '     Project Settings -> Service Accounts -> Generate Key',
          '  2. Set these env vars in your .env file:',
          '     FIREBASE_PROJECT_ID=<project_id>',
          '     FIREBASE_CLIENT_EMAIL=<client_email>',
          '     FIREBASE_PRIVATE_KEY="<full private key with BEGIN/END>"'
        ].join('\n'),
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

function getFirebaseAuth() {
  const app = getFirebaseAdminApp();
  return app ? getAuthInstance(app) : null;
}

function isFirebaseUserNotFound(error) {
  const code = String(error && error.code ? error.code : '');
  return code === 'auth/user-not-found' || code.endsWith('/user-not-found');
}

function buildFirebaseAuthPayload(user, plainPassword) {
  const fullName = `${user.first_name || ''} ${user.last_name || ''}`.trim();
  const payload = {
    email: (user.email || '').trim().toLowerCase(),
    displayName: fullName || undefined,
    emailVerified: Number(user.is_verified) === 1,
    disabled: Number(user.is_frozen) === 1
  };

  if (plainPassword) {
    payload.password = plainPassword;
  }

  return payload;
}

async function syncLocalUserToFirebaseAuth(user, plainPassword) {
  const firebaseAuth = getFirebaseAuth();
  if (!firebaseAuth || !user || !user.email) {
    return { synced: false, skipped: true };
  }

  const desiredUid = `ucb-${user.id}`;
  const authPayload = buildFirebaseAuthPayload(user, plainPassword);
  let authRecord = null;

  try {
    authRecord = await firebaseAuth.getUser(desiredUid);
  } catch (error) {
    if (!isFirebaseUserNotFound(error)) {
      throw error;
    }
  }

  if (!authRecord) {
    try {
      authRecord = await firebaseAuth.getUserByEmail(authPayload.email);
    } catch (error) {
      if (!isFirebaseUserNotFound(error)) {
        throw error;
      }
    }
  }

  if (authRecord) {
    authRecord = await firebaseAuth.updateUser(authRecord.uid, authPayload);
  } else {
    authRecord = await firebaseAuth.createUser({
      uid: desiredUid,
      ...authPayload,
      password: authPayload.password || crypto.randomBytes(24).toString('hex')
    });
  }

  await firebaseAuth.setCustomUserClaims(authRecord.uid, {
    local_user_id: Number(user.id),
    role: user.role || (Number(user.is_admin) === 1 ? 'super_admin' : 'customer'),
    is_admin: Number(user.is_admin) === 1
  });

  return { synced: true, uid: authRecord.uid };
}

module.exports = {
  admin,
  hasAdminCredentials,
  normalizePrivateKey,
  getFirebaseAdminApp,
  getFirestore,
  getFirebaseAuth,
  syncLocalUserToFirebaseAuth,
  getFirestoreAdminDiagnostics,
  logFirestoreDiagnostics,
  getResolvedProjectId
};
