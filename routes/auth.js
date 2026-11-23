const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { createFirestoreRepository } = require('../services/firestore-rest');
const firebaseAuth = require('../services/firebase-auth-rest');
const { sendAccountWelcomeEmail, sendLoginWelcomeEmail } = require('../services/email');
const requireSessionEncryptionReady = require('../middleware/session-encryption-ready');
const router = express.Router();
const repo = createFirestoreRepository();
const nowIso = () => new Date().toISOString();
const clean = value => String(value || '').trim();
function sessionTokens(req, auth) {
  req.session.firebaseIdToken = auth.idToken;
  req.session.firebaseRefreshToken = auth.refreshToken;
  req.session.firebaseExpiresIn = auth.expiresIn;
}
router.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/user/dashboard');
  res.render('auth/register', { title: 'Open Account - United Credit Bank', page: 'register', old: {} });
});
router.post('/register', [
  body('first_name').trim().isLength({ min: 2 }).withMessage('First name is required'),
  body('last_name').trim().isLength({ min: 2 }).withMessage('Last name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('phone').isLength({ min: 6 }).withMessage('Phone number is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('confirm_password').custom((value, { req }) => { if (value !== req.body.password) throw new Error('Passwords do not match'); return true; }),
  body('terms').custom(value => { if (!value) throw new Error('You must agree to the Terms & Conditions'); return true; })
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.render('auth/register', { title: 'Open Account - United Credit Bank', page: 'register', old: req.body, errors: errors.array() });
  const first_name = clean(req.body.first_name), last_name = clean(req.body.last_name);
  const email = clean(req.body.email).toLowerCase(), phone = clean(req.body.phone);
  let auth;
  try {
    auth = await firebaseAuth.signUpWithPassword(email, req.body.password, { displayName: `${first_name} ${last_name}` });
    const uid = String(auth.localId), accountId = crypto.randomUUID(), stamp = nowIso();
    const user = {
      id: uid, first_name, last_name, email, phone,
      address: clean(req.body.address), city: clean(req.body.city), state: clean(req.body.state), postcode: clean(req.body.postcode),
      date_of_birth: clean(req.body.date_of_birth) || null, profile_image: '', is_admin: 0, is_verified: 0,
      is_frozen: 0, role: 'customer', created_at: stamp, updated_at: stamp
    };
    const accountNumber = `${Date.now()}${crypto.randomInt(100000, 999999)}`;
    await repo.runTransaction(async tx => {
      const duplicate = await tx.list('users', [{ field: 'email', value: email }], { limit: 1 });
      if (duplicate.length) throw Object.assign(new Error('An account with this email already exists.'), { duplicate: true });
      tx.create('users', uid, user);
      tx.create('accounts', accountId, { user_id: uid, account_number: accountNumber, account_type: 'Everyday Savings', account_name: `${first_name} ${last_name}`, status: 'active', balance_minor: 0, created_at: stamp, updated_at: stamp });
      tx.create('ledger_entries', crypto.randomUUID(), { user_id: uid, account_id: accountId, amount_minor: 0, entry_type: 'account_opening', description: 'Account opened', created_at: stamp });
    });
    sendAccountWelcomeEmail(user).catch(error => console.error('Welcome email failed:', error));
    req.session.success = 'Account created successfully! Please login to continue.';
    return res.redirect('/auth/login');
  } catch (error) {
    if (auth?.idToken) await firebaseAuth.deleteFirebaseUser(auth.idToken).catch(() => {});
    console.error('Registration failed:', error);
    return res.status(error.duplicate ? 409 : (error.status && error.status < 500 ? error.status : 503)).render('auth/register', {
      title: 'Open Account - United Credit Bank', page: 'register', old: req.body,
      error: error.message || 'Account creation could not be completed. Please try again.'
    });
  }
});
router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(Number(req.session.user?.is_admin) === 1 ? '/admin/dashboard' : '/user/dashboard');
  res.render('auth/login', { title: 'Login - United Credit Bank', page: 'login' });
});
router.post('/login', requireSessionEncryptionReady, async (req, res) => {
  const email = clean(req.body.email).toLowerCase(), password = String(req.body.password || '');
  if (!email || !password) { req.session.error = 'Email and password are required.'; return res.redirect('/auth/login'); }
  try {
    const auth = await firebaseAuth.signInWithPassword(email, password), uid = String(auth.localId);
    const user = await repo.get('users', uid);
    if (!user) { req.session.error = 'Invalid email or password.'; return res.redirect('/auth/login'); }
    if (user.is_frozen === true || Number(user.is_frozen) === 1) { req.session.error = 'Your account has been frozen. Please contact customer support.'; return res.redirect('/auth/login'); }
    sessionTokens(req, auth);
    req.session.userId = uid;
    req.session.user = { id: uid, first_name: user.first_name || '', last_name: user.last_name || '', email: user.email || email, profile_image: user.profile_image || '', is_admin: Number(user.is_admin) === 1 ? 1 : 0, is_verified: Number(user.is_verified) === 1 ? 1 : 0, is_frozen: Number(user.is_frozen) === 1 ? 1 : 0 };
    sendLoginWelcomeEmail(user, { ip: req.ip, userAgent: req.get('user-agent') }).catch(error => console.error('Login email failed:', error));
    return res.redirect(req.session.user.is_admin ? '/admin/dashboard' : '/user/dashboard');
  } catch (error) {
    console.error('Login failed:', error);
    req.session.error = error.message || 'Authentication is temporarily unavailable.';
    return res.status(error.status && error.status < 500 ? error.status : 503).redirect('/auth/login');
  }
});
router.get('/logout', requireAuth, (req, res) => {
  if (typeof req.session.destroy === 'function') return req.session.destroy(() => { res.clearCookie('connect.sid'); res.clearCookie('ucb_session'); res.redirect('/'); });
  req.session = null; res.clearCookie('ucb_session'); res.redirect('/');
});
router.get('/forgot-password', (req, res) => res.render('auth/forgot', { title: 'Forgot Password - United Credit Bank', page: 'forgot' }));
router.post('/forgot-password', async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  if (email) { try { await firebaseAuth.sendPasswordResetEmail(email); } catch (error) { console.error('Password reset request failed:', error); } }
  req.session.success = 'If your email is registered, you will receive password reset instructions shortly.';
  res.redirect('/auth/login');
});
// Identity Toolkit must verify Firebase's emailed out-of-band code; no safe token verifier is provided here.
router.get('/reset-password', (req, res) => res.status(501).render('auth/forgot', { title: 'Reset Password - United Credit Bank', page: 'forgot', error: 'Password reset links must be completed through the secure Firebase reset flow. This page cannot safely validate reset tokens.' }));
router.post('/reset-password', async (req, res) => {
  res.status(501).render('auth/forgot', { title: 'Reset Password - United Credit Bank', page: 'forgot', error: 'Password reset token verification is unavailable in this route. Request a new reset email and follow its secure Firebase flow.' });
});
module.exports = router;
