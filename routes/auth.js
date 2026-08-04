const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const { db, generateAccountNumber } = require('../database');
const { requireAuth } = require('../middleware/auth');
const {
  syncUserBundleToFirestore,
  hydrateUserFromFirestoreByEmail,
  firestoreUserExistsByEmail,
  isFirestoreEnabled
} = require('../services/firestore-sync');

const router = express.Router();

router.get('/register', (req, res) => {
  if (req.session.userId) {
    return res.redirect('/user/dashboard');
  }
  res.render('auth/register', {
    title: 'Open Account - United Credit Bank',
    page: 'register',
    old: {}
  });
});

router.post('/register', [
  body('first_name').trim().isLength({ min: 2 }).withMessage('First name is required'),
  body('last_name').trim().isLength({ min: 2 }).withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').isLength({ min: 6 }).withMessage('Phone number is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('confirm_password').custom((value, { req }) => {
    if (value !== req.body.password) {
      throw new Error('Passwords do not match');
    }
    return true;
  }),
  body('terms').custom((value, { req }) => {
    if (!value) {
      throw new Error('You must agree to the Terms & Conditions');
    }
    return true;
  })
], async (req, res) => {
  const entryTag = `[UCB-REGISTER-ENTRY][${Date.now()}]`;
  console.log(`${entryTag} POST /auth/register RECEIVED body_keys=${Object.keys(req.body).join(',')}`);
  console.log(`${entryTag} first_name="${req.body.first_name}" last_name="${req.body.last_name}" email="${req.body.email}" terms="${req.body.terms}"`);

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const errMsgs = errors.array().map(e => e.msg).join('; ');
    console.log(`${entryTag} express-validator FAILED: ${errMsgs}`);
    return res.render('auth/register', {
      title: 'Open Account - United Credit Bank',
      page: 'register',
      old: req.body,
      errors: errors.array(),
      error: null
    });
  }

  if (!req.body.terms) {
    console.log(`${entryTag} SERVER-SIDE terms check FAILED (req.body.terms falsy). Rendering with error.`);
    const termErrMsg = 'You must agree to the Terms & Conditions to continue.';
    return res.render('auth/register', {
      title: 'Open Account - United Credit Bank',
      page: 'register',
      old: req.body,
      errors: [{ msg: termErrMsg }],
      error: termErrMsg
    });
  }

  const { first_name, last_name, email, phone, password, address, city, state, postcode, date_of_birth } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existingUser) {
    console.log(`${entryTag} Duplicate email in SQLite: ${normalizedEmail}`);
    const dupErr = 'An account with this email already exists.';
    req.session.error = dupErr;
    return res.render('auth/register', {
      title: 'Open Account - United Credit Bank',
      page: 'register',
      old: req.body,
      error: dupErr
    });
  }

  if (isFirestoreEnabled()) {
    try {
      const existsRemotely = await firestoreUserExistsByEmail(normalizedEmail);
      if (existsRemotely) {
        console.log(`${entryTag} Duplicate email in Firestore: ${normalizedEmail}`);
        const dupErr = 'An account with this email already exists.';
        req.session.error = dupErr;
        return res.render('auth/register', {
          title: 'Open Account - United Credit Bank',
          page: 'register',
          old: req.body,
          error: dupErr
        });
      }
    } catch (error) {
      console.error(`${entryTag} Failed checking Firestore for existing user:`, error);
      const sysErr = 'We could not verify your details right now. Please try again.';
      req.session.error = sysErr;
      return res.render('auth/register', {
        title: 'Open Account - United Credit Bank',
        page: 'register',
        old: req.body,
        error: sysErr
      });
    }
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const insertUser = db.prepare(`
    INSERT INTO users (
      first_name, last_name, email, phone, password, address, city, state, postcode, date_of_birth,
      is_admin, is_verified, is_frozen, role
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'customer')
  `);
  const result = insertUser.run(
    first_name.trim(),
    last_name.trim(),
    normalizedEmail,
    phone.trim(),
    hashedPassword,
    address || '',
    city || '',
    state || '',
    postcode || '',
    date_of_birth || null
  );

  const accountNumber = generateAccountNumber();
  const insertAccount = db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, account_name, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAccount.run(
    result.lastInsertRowid,
    accountNumber,
    'Everyday Savings',
    `${first_name} ${last_name}`,
    'active'
  );

  let firestoreSyncAttempted = false;
  let firestoreSyncSkipped = false;
  const vercelDeployment = Boolean(process.env.VERCEL);
  const requestTag = `[UCB-REGISTER][${normalizedEmail}][sql_user=${result.lastInsertRowid}]`;

  console.log(`${requestTag} step=local_sqlite_insert status=ok account_number=${accountNumber} serverless=${vercelDeployment}`);

  if (isFirestoreEnabled()) {
    firestoreSyncAttempted = true;
    console.log(`${requestTag} step=firestore_sync status=attempting`);
    try {
      const synced = await syncUserBundleToFirestore(result.lastInsertRowid);
      if (!synced) {
        throw new Error('Firestore sync did not complete (syncUserBundleToFirestore returned falsy).');
      }
      console.log(`${requestTag} step=firestore_sync status=ok`);
    } catch (error) {
      console.error(`${requestTag} step=firestore_sync status=FAILED error=${String(error.message || error)}`);
      console.error(`${requestTag} rolling_back_local_sqlite ...`);
      try {
        db.prepare('DELETE FROM accounts WHERE user_id = ?').run(result.lastInsertRowid);
        db.prepare('DELETE FROM users WHERE id = ?').run(result.lastInsertRowid);
        console.error(`${requestTag} rolling_back_local_sqlite status=ok`);
      } catch (rbErr) {
        console.error(`${requestTag} rolling_back_local_sqlite status=FAILED err=${String(rbErr.message || rbErr)}`);
      }
      const syncErr = 'Account creation could not be completed right now. Please try again.';
      req.session.error = syncErr;
      return res.render('auth/register', {
        title: 'Open Account - United Credit Bank',
        page: 'register',
        old: req.body,
        error: syncErr
      });
    }
  } else {
    firestoreSyncSkipped = true;
    console.warn(`${requestTag} step=firestore_sync status=SKIPPED reason=isFirestoreEnabled() returned false`);
    if (vercelDeployment) {
      console.warn(`${requestTag} VERCEL FIX: Visit https://<your-domain>/api/debug/firestore to see exactly which env var is invalid (private_key_valid / client_email etc). Then Vercel Dashboard → Settings → Environment Variables → set correctly → Redeploy.`);
    }
    console.warn(
      '============================================================\n' +
      '  [AUTH REGISTER] WARNING: FIRESTORE SYNC SKIPPED\n' +
      '  User was registered locally (SQLite) but NOT synced to Firestore.\n' +
      '  This means the user will NOT appear in Firebase Console.\n' +
      '  User ID: ' + result.lastInsertRowid + '\n' +
      '  Email: ' + normalizedEmail + '\n' +
      (vercelDeployment
        ? '  VERCEL FIX: Visit /api/debug/firestore on your deployed site for the exact env var validation errors.\n'
        : '  Local fix: Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in your .env.\n') +
      '============================================================'
    );
  }

  if (firestoreSyncSkipped && process.env.FIRESTORE_REQUIRE_SYNC_ON_REGISTER === 'true') {
    console.warn(`${requestTag} step=local_sqlite_rollback reason=FIRESTORE_REQUIRE_SYNC_ON_REGISTER=true and sync skipped`);
    db.prepare('DELETE FROM accounts WHERE user_id = ?').run(result.lastInsertRowid);
    db.prepare('DELETE FROM users WHERE id = ?').run(result.lastInsertRowid);
    const requireErr = 'Account creation could not be completed right now. The remote user database is unavailable. Please try again later.';
    req.session.error = requireErr;
    return res.render('auth/register', {
      title: 'Open Account - United Credit Bank',
      page: 'register',
      old: req.body,
      error: requireErr
    });
  }

  req.session.success = firestoreSyncSkipped
    ? 'Account created locally! Note: Remote sync is currently unavailable. Your account will be synced when the service is restored. Please login to continue.'
    : 'Account created successfully! Please login to continue.';
  console.log(`${requestTag} registration_complete final_status=${firestoreSyncAttempted ? 'synced_firestore' : 'local_only'}`);
  res.redirect('/auth/login');
});

router.get('/login', (req, res) => {
  if (req.session.userId) {
    if (req.session.user && Number(req.session.user.is_admin) === 1) {
      return res.redirect('/admin/dashboard');
    }
    return res.redirect('/user/dashboard');
  }
  res.render('auth/login', {
    title: 'Login - United Credit Bank',
    page: 'login'
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    req.session.error = 'Email and password are required.';
    return res.redirect('/auth/login');
  }

  const normalizedEmail = email.trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);

  if (!user && isFirestoreEnabled()) {
    try {
      user = await hydrateUserFromFirestoreByEmail(normalizedEmail);
    } catch (error) {
      console.error('Failed to hydrate user from Firestore during login:', error);
    }
  }

  if (!user) {
    req.session.error = 'Invalid email or password.';
    return res.redirect('/auth/login');
  }

  const isValid = await bcrypt.compare(password, user.password);
  if (!isValid) {
    req.session.error = 'Invalid email or password.';
    return res.redirect('/auth/login');
  }

  if (user.is_frozen === 1) {
    req.session.error = 'Your account has been frozen. Please contact customer support.';
    return res.redirect('/auth/login');
  }

  db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

  if (isFirestoreEnabled()) {
    syncUserBundleToFirestore(user.id).catch((error) => {
      console.error('Failed to sync login update to Firestore:', error);
    });
  }

  req.session.userId = user.id;
  const isAdmin = Number(user.is_admin) === 1 ? 1 : 0;

  req.session.user = {
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    is_admin: isAdmin,
    is_verified: Number(user.is_verified) === 1 ? 1 : 0,
    is_frozen: Number(user.is_frozen) === 1 ? 1 : 0
  };

  if (isAdmin === 1) {
    return res.redirect('/admin/dashboard');
  }
  res.redirect('/user/dashboard');
});

router.get('/logout', requireAuth, (req, res) => {
  if (typeof req.session.destroy === 'function') {
    return req.session.destroy(() => {
      res.clearCookie('connect.sid');
      res.clearCookie('ucb_session');
      res.redirect('/');
    });
  }

  req.session = null;
  res.clearCookie('ucb_session');
  res.redirect('/');
});

router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot', {
    title: 'Forgot Password - United Credit Bank',
    page: 'forgot'
  });
});

router.post('/forgot-password', (req, res) => {
  req.session.success = 'If your email is registered, you will receive password reset instructions shortly.';
  res.redirect('/auth/login');
});

module.exports = router;
