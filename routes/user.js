'use strict';

const express = require('express');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { uploadObject } = require('../services/firebase-storage');
const { fromMinorUnits } = require('../services/money');
const { requireAuth } = require('../middleware/auth');
const { emailsMatch } = require('../services/authenticated-profile');
const { ownerIdsForRequest, listByOwnerIds, recordHasOwnerId } = require('../services/owner-records');

const router = express.Router();
const repo = createFirestoreRepository();
const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 512 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) return callback(new Error('Please upload a JPG, PNG, GIF, or WEBP image.'));
    callback(null, true);
  }
});

function handleProfileUpload(req, res, next) {
  profileUpload.single('profile_image')(req, res, (error) => {
    if (!error) return next();
    req.session.error = error.code === 'LIMIT_FILE_SIZE' ? 'Profile pictures must be 512 KB or smaller.' : error.message || 'Unable to upload that profile picture.';
    return res.redirect('/user/profile');
  });
}
function hasTransferPin(user) { return Boolean(user && user.transfer_pin_hash); }
function profileDocumentId(req) { return String(req.session.profileId || req.user?.profileId || req.user?.id || req.session.userId || ''); }
function amount(doc, field) {
  const minor = doc[`${field}_minor`];
  return Number.isSafeInteger(minor) ? fromMinorUnits(minor) : 0;
}
function present(doc) {
  if (!doc) return doc;
  const result = { ...doc };
  for (const field of ['amount', 'fee', 'balance', 'available_balance', 'credit_limit', 'principal', 'payment_amount']) {
    if (Object.prototype.hasOwnProperty.call(doc, `${field}_minor`)) result[field] = amount(doc, field);
  }
  return result;
}
async function ownedList(collection, req, options = {}) {
  return (await listByOwnerIds(repo, collection, ownerIdsForRequest(req), [], options)).map(present);
}
async function latestKyc(req) {
  const rows = await ownedList('kyc', req, { orderBy: { field: 'created_at', direction: 'desc' }, limit: 1 });
  return rows[0] || null;
}
function completed(tx) { return tx.status === 'completed'; }
function incoming(tx) { return completed(tx) && (tx.transaction_type === 'admin_adjustment' ? amount(tx, 'amount') > 0 : ['deposit', 'loan_disbursement'].includes(tx.transaction_type)); }
function outgoing(tx) { return completed(tx) && (tx.transaction_type === 'admin_adjustment' ? amount(tx, 'amount') < 0 : ['withdrawal', 'local_transfer', 'international_transfer', 'bill_payment', 'loan_payment'].includes(tx.transaction_type)); }
function creditTotal(rows) { return rows.reduce((n, tx) => n + (incoming(tx) ? Math.abs(amount(tx, 'amount')) : 0), 0); }
function debitTotal(rows) { return rows.reduce((n, tx) => n + (outgoing(tx) ? Math.abs(amount(tx, 'amount')) + Math.abs(amount(tx, 'fee')) : 0), 0); }
function renderError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 'unknown';
  const code = typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'unknown';
  console.error(`User route Firestore operation failed (status=${status}, code=${code}).`);
  return res.status(503).render('error', { message: 'This service is temporarily unavailable.' });
}

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const uid = req.session.userId, profileId = profileDocumentId(req), ownerIds = ownerIdsForRequest(req);
    const [user, accounts, tx, notifications, kyc, cards, loans, completedTx] = await Promise.all([
      repo.get('users', profileId), ownedList('accounts', req), ownedList('transactions', req, { orderBy: { field: 'created_at', direction: 'desc' }, limit: 25 }),
      ownedList('notifications', req, { orderBy: { field: 'created_at', direction: 'desc' }, limit: 5 }), latestKyc(req), ownedList('cards', req), ownedList('loans', req),
      listByOwnerIds(repo, 'transactions', ownerIds, [{ field: 'status', value: 'completed' }], { orderBy: { field: 'created_at', direction: 'desc' }, limit: 1000 })
    ]);
    const transactions = tx.map(present), completedTransactions = completedTx.map(present);
    const pending = async (collection) => (await listByOwnerIds(repo, collection, ownerIds, [{ field: 'status', value: 'pending' }])).length;
    const [pendingTransfers, pendingCards, pendingLoans] = await Promise.all([pending('transactions'), pending('cards'), pending('loans')]);
    return res.render('user/dashboard', { title: 'Dashboard - United Credit Bank', page: 'dashboard', user, accounts, transactions, notifications, kyc, cards, loans,
      totalBalance: accounts.reduce((n, x) => n + amount(x, 'balance'), 0), totalAvailable: accounts.reduce((n, x) => n + amount(x, 'available_balance'), 0),
      totalCardCredit: cards.reduce((n, x) => n + amount(x, 'credit_limit'), 0), totalCredits: creditTotal(completedTransactions), totalDebits: debitTotal(completedTransactions), pendingTransfers, pendingCards, pendingLoans });
  } catch (error) { return renderError(res, error); }
});

router.get('/profile', requireAuth, async (req, res) => {
  try { return res.render('user/profile', { title: 'My Profile - United Credit Bank', page: 'profile', user: await repo.get('users', profileDocumentId(req)) }); }
  catch (error) { return renderError(res, error); }
});

router.post('/profile/photo', requireAuth, handleProfileUpload, async (req, res) => {
  if (!req.file) { req.session.error = 'Please choose a profile picture to upload.'; return res.redirect('/user/profile'); }
  const uid = req.session.userId;
  try {
    const object = await uploadObject(`profile-images/${uid}/${require('crypto').randomUUID()}`, req.file.buffer, req.file.mimetype);
    const profile_image = `gs://${object.name}`;
    await repo.update('users', profileDocumentId(req), { profile_image, updated_at: new Date().toISOString() });
    req.session.user = { ...(req.session.user || {}), profile_image };
    req.session.success = 'Profile picture updated successfully.';
    return res.redirect('/user/profile');
  } catch (error) { return renderError(res, error); }
});

router.post('/profile', requireAuth, [body('first_name').trim().isLength({ min: 2 }), body('last_name').trim().isLength({ min: 2 }), body('phone').isLength({ min: 6 }), body('email').isEmail()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) { req.session.error = 'Please check your input and try again.'; return res.redirect('/user/profile'); }
  try {
    const { first_name, last_name, email, phone, address, city, state, postcode, date_of_birth } = req.body;
    const profileId = profileDocumentId(req);
    if (!emailsMatch(email, req.user?.email)) {
      req.session.error = 'Email changes require the verified Firebase account workflow. Please contact support.';
      return res.redirect('/user/profile');
    }
    const duplicates = await repo.list('users', [{ field: 'email', value: email }], { limit: 10 });
    if (duplicates.some((u) => u.id !== profileId)) { req.session.error = 'This email is already in use.'; return res.redirect('/user/profile'); }
    await repo.update('users', profileId, { first_name, last_name, email, phone, address, city, state, postcode, date_of_birth, updated_at: new Date().toISOString() });
    req.session.user = { ...(req.session.user || {}), first_name, last_name, email };
    req.session.success = 'Profile updated successfully.';
    return res.redirect('/user/profile');
  } catch (error) { return renderError(res, error); }
});

router.get('/settings', requireAuth, async (req, res) => {
  try { const user = await repo.get('users', profileDocumentId(req)); return res.render('user/settings', { title: 'Settings - United Credit Bank', page: 'settings', user, hasTransferPin: hasTransferPin(user) }); }
  catch (error) { return renderError(res, error); }
});

// Password credential operations are owned by Firebase Auth; change-password UI must reauthenticate separately.
router.post('/change-password', requireAuth, [body('current_password').exists(), body('new_password').isLength({ min: 8 }), body('confirm_password').custom((v, { req }) => v === req.body.new_password)], (_req, res) => res.status(501).send('Password change requires Firebase reauthentication.'));
router.post('/settings/transfer-pin', requireAuth, (_req, res) => res.status(501).send('Transfer PIN updates are unavailable until Firebase reauthentication is implemented.'));

router.get('/statements', requireAuth, async (req, res) => {
  try {
    const accounts = await ownedList('accounts', req);
    const selectedAccount = req.query.account ? accounts.find((a) => a.id === String(req.query.account)) : accounts[0];
    let transactions = [], statementCredits = 0, statementDebits = 0;
    if (selectedAccount) {
      transactions = (await listByOwnerIds(repo, 'transactions', ownerIdsForRequest(req), [{ field: 'account_id', value: selectedAccount.id }], { orderBy: { field: 'created_at', direction: 'desc' }, limit: 500 })).map(present);
      statementCredits = creditTotal(transactions); statementDebits = debitTotal(transactions);
    }
    return res.render('user/statements', { title: 'Account Statements - United Credit Bank', page: 'statements', accounts, selectedAccount, transactions, statementCredits, statementDebits });
  } catch (error) { return renderError(res, error); }
});

router.get('/beneficiaries', requireAuth, async (req, res) => {
  try { return res.render('user/beneficiaries', { title: 'Beneficiaries - United Credit Bank', page: 'beneficiaries', beneficiaries: await ownedList('beneficiaries', req) }); }
  catch (error) { return renderError(res, error); }
});
router.post('/beneficiaries/add', requireAuth, async (req, res) => {
  try {
    const { name, account_number, bsb, bank_name, swift_code, iban, country, is_international } = req.body;
    await repo.create('beneficiaries', { user_id: req.session.userId, name, account_number, bsb: bsb || '', bank_name: bank_name || '', swift_code: swift_code || '', iban: iban || '', country: country || 'Australia', is_international: Boolean(is_international), created_at: new Date().toISOString() });
    req.session.success = 'Beneficiary added successfully.'; return res.redirect('/user/beneficiaries');
  } catch (error) { return renderError(res, error); }
});
router.post('/beneficiaries/delete/:id', requireAuth, async (req, res) => {
  try {
    const doc = await repo.get('beneficiaries', req.params.id);
    if (doc && recordHasOwnerId(doc, ownerIdsForRequest(req))) await repo.delete('beneficiaries', doc.id);
    req.session.success = 'Beneficiary removed.'; return res.redirect('/user/beneficiaries');
  } catch (error) { return renderError(res, error); }
});
router.get('/notifications', requireAuth, async (req, res) => {
  try { return res.render('user/notifications', { title: 'Notifications - United Credit Bank', page: 'notifications', notifications: await ownedList('notifications', req, { orderBy: { field: 'created_at', direction: 'desc' } }) }); }
  catch (error) { return renderError(res, error); }
});
router.post('/notifications/read/:id', requireAuth, async (req, res) => {
  try {
    const doc = await repo.get('notifications', req.params.id);
    if (doc && recordHasOwnerId(doc, ownerIdsForRequest(req))) await repo.update('notifications', doc.id, { is_read: true });
    return res.json({ success: true });
  } catch (error) { return res.status(503).json({ success: false, error: 'Notifications are temporarily unavailable.' }); }
});
router.get('/support', requireAuth, (_req, res) => res.render('user/support', { title: 'Support - United Credit Bank', page: 'support' }));

module.exports = router;
