require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieSession = require('cookie-session');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const cookieParser = require('cookie-parser');
const moment = require('moment');

const { db } = require('./database');
const {
  hydrateUserFromFirestoreById,
  isFirestoreEnabled,
  syncConfiguredAdminToFirestore,
  backfillLocalUsersToFirestore
} = require('./services/firestore-sync');
const { logFirestoreDiagnostics, getFirestoreAdminDiagnostics, getResolvedProjectId } = require('./lib/firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const RESOLVED_FIREBASE_PROJECT_ID = getResolvedProjectId();
const firebaseWebConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyDGSYkZdTDDj_ucCKjkiC-8WejvdnrVfSQ',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || `${RESOLVED_FIREBASE_PROJECT_ID}.firebaseapp.com`,
  projectId: RESOLVED_FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${RESOLVED_FIREBASE_PROJECT_ID}.firebasestorage.app`,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '54110165279',
  appId: process.env.FIREBASE_APP_ID || '1:54110165279:web:04ddda35bfc2624f87b82a',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-HWYB1Q883J'
};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const sessionSecret = process.env.SESSION_SECRET || 'united-credit-bank-super-secret-key-2026';

if (isServerless) {
  app.use(cookieSession({
    name: 'ucb_session',
    keys: [sessionSecret],
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }));
} else {
  const sessionConfig = {
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production'
    }
  };
  const sessionPath = path.join(__dirname, '.sessions');
  fs.mkdirSync(sessionPath, { recursive: true });
  sessionConfig.store = new FileStore({
    path: sessionPath,
    retries: 1
  });
  app.use(session(sessionConfig));
}

(function runFirestoreStartupCheck() {
  console.log('\n============================================================');
  console.log('  UNITED CREDIT BANK - FIRESTORE STARTUP CHECK');
  console.log('============================================================');
  const diag = getFirestoreAdminDiagnostics();
  console.log(`  Runtime env:       ${diag.runtime}${diag.isServerless ? ' (serverless)' : ''}`);
  console.log(`  Project ID:        ${diag.projectIdResolved} (env var set: ${diag.projectIdSet ? 'yes' : 'using default'})`);
  console.log(`  Admin creds ready: ${diag.hasAdminCredentials ? 'YES' : 'NO'}`);
  console.log(`  Client email:      ${diag.clientEmailSet ? (diag.clientEmailLooksValid ? 'SET & VALID' : 'SET but INVALID format') : 'NOT SET'}`);
  console.log(`  Private key:       ${diag.privateKeySet ? `SET (raw=${diag.privateKeyRawLength}, normalized=${diag.normalizedPrivateKeyLength})` : 'NOT SET (CRITICAL)'}`);
  console.log(`  Key VALID:         ${diag.privateKeyValid ? 'YES ✓' : 'NO ✗  -> ' + diag.privateKeyReason}`);
  console.log(`  Init error:        ${diag.initError ? diag.initError.split('\n')[0] : 'none'}`);

  const enabled = isFirestoreEnabled();
  console.log(`  Firestore enabled: ${enabled ? 'YES' : 'NO'}`);

  if (!enabled) {
    console.log('------------------------------------------------------------');
    console.log('  ⚠️   WARNING: FIRESTORE ADMIN IS NOT CONFIGURED!');
    console.log('  ----------------------------------------------------------');
    console.log('  User registration will still work locally (SQLite), but');
    console.log('  users/accounts WILL NOT be synced to Firestore/Firebase.');
    console.log('');
    if (diag.runtime === 'vercel') {
      console.log('  VERCEL DEPLOYMENT FIX STEPS:');
      console.log('  1. Go to: Vercel Dashboard → your-project → Settings →');
      console.log('     Environment Variables');
      console.log('  2. Ensure these are set (then Redeploy!):');
      console.log('     • FIREBASE_CLIENT_EMAIL');
      console.log('       (e.g. firebase-adminsdk-XXX@project.iam.gserviceaccount.com)');
      console.log('     • FIREBASE_PRIVATE_KEY');
      console.log('       PASTE THE FULL KEY WITH REAL LINE BREAKS.');
      console.log('       Do NOT wrap in extra quotes.');
      console.log('     • Optional: FIREBASE_PROJECT_ID (e.g. unitedcb-4845b)');
      console.log('');
      console.log('  3. After redeploying, visit:');
      console.log('     https://<your-domain>/api/debug/firestore');
      console.log('     to confirm isFirestoreEnabled = YES and private_key_valid = YES');
    } else {
      console.log('  To enable Firestore sync, add these to your .env file:');
      console.log('');
      console.log('  FIREBASE_CLIENT_EMAIL=<your-service-account-email>');
      console.log('  FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----');
      console.log('    ...your full private key...');
      console.log('    -----END PRIVATE KEY-----"');
      console.log('');
      console.log('  Get these from: Firebase Console → Project Settings →');
      console.log('  Service Accounts → Generate new private key (JSON)');
    }
    console.log('');
    console.log('  Optional: Set FIRESTORE_REQUIRE_SYNC_ON_REGISTER=true');
    console.log('  to FAIL registration if Firestore is unavailable.');
    console.log('============================================================\n');
  } else {
    console.log(`  Firestore ready for project "${diag.projectIdResolved}"`);
    console.log('============================================================\n');
    syncConfiguredAdminToFirestore().catch((error) => {
      console.error('Failed to sync configured admin to Firestore:', error);
    });
    const shouldBackfill = process.env.FIRESTORE_SKIP_STARTUP_BACKFILL !== 'true';
    if (shouldBackfill) {
      backfillLocalUsersToFirestore(500).catch((error) => {
        console.error('Firestore startup backfill failed:', error);
      });
    }
  }
})();

app.use((req, res, next) => {
  res.locals.moment = moment;
  res.locals.currency = (amount, currency = 'AUD') => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: currency
    }).format(amount || 0);
  };
  res.locals.user = req.session.user || null;
  res.locals.error = req.session.error || null;
  res.locals.success = req.session.success || null;
  res.locals.firebaseWebConfig = firebaseWebConfig;
  delete req.session.error;
  delete req.session.success;

  const originalRender = res.render.bind(res);
  res.render = function patchedRender(view, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    if (typeof opts !== 'object' || opts === null) {
      opts = {};
    }

    if (typeof opts.error === 'undefined') {
      if (res.locals.error) {
        opts.error = res.locals.error;
      } else if (req.session && req.session.error) {
        opts.error = req.session.error;
        delete req.session.error;
        res.locals.error = opts.error;
      }
    }

    if (typeof opts.success === 'undefined') {
      if (res.locals.success) {
        opts.success = res.locals.success;
      } else if (req.session && req.session.success) {
        opts.success = req.session.success;
        delete req.session.success;
        res.locals.success = opts.success;
      }
    }

    return originalRender(view, opts, cb);
  };

  next();
});

app.use(async (req, res, next) => {
  if (req.session.userId) {
    let user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user && isFirestoreEnabled()) {
      try {
        user = await hydrateUserFromFirestoreById(req.session.userId);
      } catch (error) {
        console.error('Failed to hydrate session user from Firestore:', error);
      }
    }
    if (user) {
      const isAdmin = Number(user.is_admin) === 1 ? 1 : 0;

      req.user = user;
      req.session.user = {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        is_admin: isAdmin,
        is_verified: Number(user.is_verified) === 1 ? 1 : 0,
        is_frozen: Number(user.is_frozen) === 1 ? 1 : 0
      };
    } else {
      req.session.user = null;
      req.session.userId = null;
    }
  }
  next();
});

const indexRoutes = require('./routes/index');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const accountRoutes = require('./routes/accounts');
const transferRoutes = require('./routes/transfers');
const cardRoutes = require('./routes/cards');
const loanRoutes = require('./routes/loans');
const kycRoutes = require('./routes/kyc');
const billPayRoutes = require('./routes/billpay');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

app.use('/', indexRoutes);
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/accounts', accountRoutes);
app.use('/transfers', transferRoutes);
app.use('/cards', cardRoutes);
app.use('/loans', loanRoutes);
app.use('/kyc', kycRoutes);
app.use('/billpay', billPayRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).render('errors/404', {
    title: 'Page Not Found - United Credit Bank',
    page: '404'
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).render('errors/500', {
    title: 'Server Error - United Credit Bank',
    page: '500',
    error: process.env.NODE_ENV === 'development' ? err.message : null
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`United Credit Bank server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
