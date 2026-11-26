'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { toMinorUnits, readMinorUnits, fromMinorUnits } = require('../services/money');
const { requireAuth, requireVerified, getAccountStatusMessage } = require('../middleware/auth');
const { sendTransactionActivityEmailById } = require('../services/email');
const { ownerIdsForRequest, listByOwnerIds, recordHasOwnerId, getOwnedAccount } = require('../services/owner-records');

const router = express.Router();
router.use(require('../middleware/production-financial-gate'));
const repo = createFirestoreRepository();
const OUTGOING_TYPES = new Set(['local_transfer', 'international_transfer', 'withdrawal', 'bill_payment', 'loan_payment']);
const nowIso = () => new Date().toISOString();
const sessionUid = req => String(req.session.userId);
const sessionProfileId = req => String(req.session.profileId || req.user?.profileId || req.user?.id || req.session.userId);
const sessionOwnerIds = req => ownerIdsForRequest(req);
const asMinor = (account, key) => {
  const balanceFallback = key === 'available_balance' ? readMinorUnits(account, 'balance_minor', 'balance') : 0;
  return readMinorUnits(account, `${key}_minor`, key, balanceFallback);
};

function queueTransactionEmail(txnId, note, authenticatedUser) {
  if (!txnId) return;
  sendTransactionActivityEmailById(txnId, { ...(note ? { note } : {}), authenticatedUser }).catch(error => console.error(`Failed to send transaction email for txn ${txnId}:`, error));
}
async function getTransferUser(profileId) { return repo.get('users', profileId); }
async function validateTransferPin(profileId, pin) {
  const user = await getTransferUser(profileId);
  if (!user || !user.transfer_pin_hash) return { ok: false, code: 'missing' };
  if (!pin) return { ok: false, code: 'required' };
  const matches = await bcrypt.compare(pin, user.transfer_pin_hash);
  return { ok: matches, code: matches ? 'ok' : 'invalid' };
}
async function getAccounts(ownerIds, operableOnly = false) {
  let list = await listByOwnerIds(repo, 'accounts', ownerIds);
  list = list.map(a => ({ ...a, balance: fromMinorUnits(asMinor(a, 'balance')), available_balance: fromMinorUnits(asMinor(a, 'available_balance')) }));
  if (operableOnly) list = list.filter(a => !getAccountStatusMessage(a, 'make transfers'));
  return list;
}
async function getBeneficiaries(ownerIds, international) {
  return listByOwnerIds(repo, 'beneficiaries', ownerIds, [{ field: 'is_international', value: international }]);
}
async function getRecent(ownerIds) {
  const txns = await listByOwnerIds(repo, 'transactions', ownerIds, [], { orderBy: { field: 'created_at', direction: 'desc' }, limit: 100 });
  const recent = txns.filter(t => ['transfer', 'international_transfer', 'local_transfer'].includes(t.transaction_type)).slice(0, 10);
  return Promise.all(recent.map(async t => {
    const account = await repo.get('accounts', t.account_id);
    return { ...displayTransaction(t), from_account: recordHasOwnerId(account, ownerIds) ? account.account_name || '' : '' };
  }));
}
function displayTransaction(t) {
  return { ...t, amount: fromMinorUnits(readMinorUnits(t, 'amount_minor', 'amount')), fee: fromMinorUnits(readMinorUnits(t, 'fee_minor', 'fee')), converted_amount: t.converted_amount_minor === undefined && t.converted_amount === undefined ? undefined : fromMinorUnits(readMinorUnits(t, 'converted_amount_minor', 'converted_amount')) };
}
async function addNotification(uid, title, message, type) {
  await repo.create('notifications', { user_id: uid, title, message, type, is_read: false, created_at: nowIso() }, crypto.randomUUID());
}
function failClosed(res, req, error) {
  console.error('Firestore transfer operation failed:', error);
  if (res.headersSent) return;
  if (req.accepts('html')) { req.session.error = 'Transfers are temporarily unavailable. Please try again later.'; return res.redirect('/transfers'); }
  return res.status(503).json({ error: 'Transfers are temporarily unavailable.' });
}
function pinError(req, pinState, path) {
  req.session.error = pinState.code === 'missing' ? 'Please create your transfer PIN in Settings before making transfers.' : pinState.code === 'required' ? 'Transfer PIN is required to authorise this transfer.' : 'Transfer PIN is incorrect.';
  return pinState.code === 'missing' ? '/user/settings' : path;
}

router.get('/', requireAuth, requireVerified, async (req, res) => {
  try {
    const owners = sessionOwnerIds(req);
    const [accounts, beneficiaries, recent] = await Promise.all([getAccounts(owners), listByOwnerIds(repo, 'beneficiaries', owners), getRecent(owners)]);
    res.render('transfers/index', { title: 'Transfers - United Credit Bank', page: 'transfers', accounts, beneficiaries, recent });
  } catch (error) { failClosed(res, req, error); }
});

router.get('/local', requireAuth, requireVerified, async (req, res) => {
  try {
    const profileId = sessionProfileId(req), owners = sessionOwnerIds(req);
    const [accounts, beneficiaries, user] = await Promise.all([getAccounts(owners, true), getBeneficiaries(owners, false), getTransferUser(profileId)]);
    const selectedAccountId = accounts.find(a => String(a.id) === String(req.query.from))?.id || accounts[0]?.id || null;
    res.render('transfers/local', { title: 'Local Transfer - United Credit Bank', page: 'transfers', accounts, beneficiaries, selectedAccountId, hasTransferPin: Boolean(user?.transfer_pin_hash) });
  } catch (error) { failClosed(res, req, error); }
});

router.post('/local', requireAuth, requireVerified, async (req, res) => {
  const uid = sessionUid(req), owners = sessionOwnerIds(req), profileId = sessionProfileId(req), { from_account, to_account, to_bsb, to_name, description, reference, save_beneficiary, beneficiary_name, transfer_pin } = req.body;
  try {
    const pin = await validateTransferPin(profileId, transfer_pin);
    if (!pin.ok) { req.session.error = pinError(req, pin, '/transfers/local'); return res.redirect(req.session.error.includes('Settings') ? '/user/settings' : '/transfers/local'); }
    const amountMinor = toMinorUnits(req.body.amount);
    if (amountMinor <= 0) throw new TypeError('Please enter a valid amount.');
    const feeMinor = amountMinor > 1_000_000 ? 1500 : 0;
    const status = amountMinor >= 500_000 ? 'pending' : 'completed';
    const txnId = crypto.randomUUID(), created = nowIso();
    await repo.runTransaction(async tx => {
      const account = await tx.get('accounts', String(from_account));
      if (!account || !recordHasOwnerId(account, owners)) throw new Error('Invalid source account.');
      const restriction = getAccountStatusMessage({ ...account, balance: fromMinorUnits(asMinor(account, 'balance')), available_balance: fromMinorUnits(asMinor(account, 'available_balance')) }, 'make transfers');
      if (restriction) throw new Error(restriction);
      const available = asMinor(account, 'available_balance'), total = amountMinor + feeMinor;
      if (total > available) throw new Error('Insufficient funds available.');
      const balance = asMinor(account, 'balance');
      tx.update('accounts', String(from_account), { available_balance_minor: available - total, ...(status === 'completed' ? { balance_minor: balance - total } : {}), updated_at: created });
      tx.create('transactions', txnId, { account_id: String(from_account), user_id: uid, transaction_type: 'local_transfer', amount_minor: amountMinor, fee_minor: feeMinor, currency: 'AUD', description: description || '', reference: reference || '', recipient_name: to_name || '', recipient_account: String(to_account || ''), recipient_bsb: to_bsb || '', recipient_bank: 'Australia', status, created_at: created });
      tx.create('ledger_entries', crypto.randomUUID(), { user_id: uid, account_id: String(from_account), transaction_id: txnId, entry_type: 'debit', amount_minor: total, currency: 'AUD', created_at: created, description: 'Local transfer' });
      if (save_beneficiary && beneficiary_name) {
        const found = await listByOwnerIds(tx, 'beneficiaries', owners, [{ field: 'account_number', value: String(to_account || '') }], { limit: 1 });
        if (!found.length) tx.create('beneficiaries', crypto.randomUUID(), { user_id: uid, name: beneficiary_name || to_name || '', account_number: String(to_account || ''), bsb: to_bsb || '', bank_name: 'Australia', country: 'Australia', is_international: false, created_at: created });
      }
    });
    await addNotification(uid, status === 'completed' ? 'Transfer Completed' : 'Transfer Pending', `${status === 'completed' ? 'Transfer completed' : 'Transfer awaiting approval'} to ${to_name || ''}`, status === 'completed' ? 'success' : 'warning');
    queueTransactionEmail(txnId, status === 'completed' ? 'Your transfer has been completed.' : 'Your transfer is pending approval.', req.user);
    req.session.success = status === 'completed' ? 'Transfer completed successfully!' : 'Transfer submitted for approval. You will be notified once processed.';
    return res.redirect('/transfers');
  } catch (error) {
    if (error instanceof TypeError || error.message === 'Insufficient funds available.' || error.message === 'Invalid source account.' || /restricted|frozen|suspended|closed/i.test(error.message)) { req.session.error = error.message; return res.redirect('/transfers/local'); }
    return failClosed(res, req, error);
  }
});

router.get('/international', requireAuth, requireVerified, async (req, res) => {
  try {
    const profileId = sessionProfileId(req), owners = sessionOwnerIds(req);
    const [accounts, beneficiaries, user] = await Promise.all([getAccounts(owners, true), getBeneficiaries(owners, true), getTransferUser(profileId)]);
    const selectedAccountId = accounts.find(a => String(a.id) === String(req.query.from))?.id || accounts[0]?.id || null;
    const countries = require('../data/countries'), currencies = require('../data/currencies');
    const rates = { AUD: 1, USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50, SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75 };
    res.render('transfers/international', { title: 'International Transfer - United Credit Bank', page: 'transfers', accounts, selectedAccountId, hasTransferPin: Boolean(user?.transfer_pin_hash), beneficiaries, countries, currencies, rates, exchangeRates: rates });
  } catch (error) { failClosed(res, req, error); }
});

router.post('/international', requireAuth, requireVerified, async (req, res) => {
  const uid = sessionUid(req), owners = sessionOwnerIds(req), profileId = sessionProfileId(req), { to_name, swift_code, country, currency, purpose, reference, save_beneficiary, beneficiary_name, transfer_pin } = req.body;
  try {
    const pin = await validateTransferPin(profileId, transfer_pin);
    if (!pin.ok) { req.session.error = pinError(req, pin, '/transfers/international'); return res.redirect(req.session.error.includes('Settings') ? '/user/settings' : '/transfers/international'); }
    const amountMinor = toMinorUnits(req.body.amount_aud || req.body.amount);
    if (amountMinor <= 0) throw new TypeError('Please enter a valid amount.');
    const rates = { AUD: 1, USD: 0.66, GBP: 0.52, EUR: 0.60, NZD: 1.10, JPY: 99.50, SGD: 0.88, HKD: 5.15, CAD: 0.89, INR: 54.80, CNY: 4.75 };
    const resolvedRate = Number(req.body.exchange_rate) || rates[currency] || 1;
    const converted = Number(req.body.amount_foreign) || (fromMinorUnits(amountMinor) * resolvedRate);
    const convertedMinor = Math.round(converted * 100), feeMinor = 2500, total = amountMinor + feeMinor;
    if (!Number.isSafeInteger(convertedMinor)) throw new TypeError('Invalid converted amount.');
    const accountId = String(req.body.from_account), recipient = String(req.body.to_account || req.body.iban || ''), txnId = crypto.randomUUID(), created = nowIso();
    await repo.runTransaction(async tx => {
      const account = await tx.get('accounts', accountId);
      if (!account || !recordHasOwnerId(account, owners)) throw new Error('Invalid source account.');
      const restriction = getAccountStatusMessage({ ...account, balance: fromMinorUnits(asMinor(account, 'balance')), available_balance: fromMinorUnits(asMinor(account, 'available_balance')) }, 'make international transfers');
      if (restriction) throw new Error(restriction);
      const available = asMinor(account, 'available_balance');
      if (total > available) throw new Error('Insufficient funds. International transfers have a $25 fee.');
      tx.update('accounts', accountId, { available_balance_minor: available - total, updated_at: created });
      tx.create('transactions', txnId, { account_id: accountId, user_id: uid, transaction_type: 'international_transfer', amount_minor: amountMinor, fee_minor: feeMinor, currency: 'AUD', description: purpose || 'International transfer', reference: reference || '', recipient_name: to_name || '', recipient_account: recipient, swift_code: swift_code || '', iban: req.body.iban || '', country: country || '', status: 'pending', exchange_rate: resolvedRate, converted_amount_minor: convertedMinor, created_at: created });
      tx.create('ledger_entries', crypto.randomUUID(), { user_id: uid, account_id: accountId, transaction_id: txnId, entry_type: 'hold', amount_minor: total, currency: 'AUD', created_at: created, description: 'International transfer hold' });
      if (save_beneficiary && beneficiary_name) tx.create('beneficiaries', crypto.randomUUID(), { user_id: uid, name: beneficiary_name || to_name || '', account_number: recipient, swift_code: swift_code || '', iban: req.body.iban || '', country: country || '', is_international: true, created_at: created });
    });
    await addNotification(uid, 'International Transfer Pending', `AUD transfer to ${to_name || ''} (${country || ''}) is awaiting approval`, 'warning');
    queueTransactionEmail(txnId, 'Your international transfer request has been submitted.', req.user);
    req.session.success = 'International transfer submitted for approval.';
    return res.redirect('/transfers');
  } catch (error) {
    if (error instanceof TypeError || error.message.startsWith('Insufficient funds') || error.message === 'Invalid source account.' || /restricted|frozen|suspended|closed/i.test(error.message)) { req.session.error = error.message; return res.redirect('/transfers/international'); }
    return failClosed(res, req, error);
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const owners = sessionOwnerIds(req), filters = [];
    if (req.query.type && req.query.type !== 'all') filters.push({ field: 'transaction_type', value: req.query.type });
    if (req.query.status && req.query.status !== 'all') filters.push({ field: 'status', value: req.query.status });
    let transactions = await listByOwnerIds(repo, 'transactions', owners, filters, { orderBy: { field: 'created_at', direction: 'desc' }, limit: 200 });
    transactions = transactions.filter(t => (!req.query.from_date || String(t.created_at) >= req.query.from_date) && (!req.query.to_date || String(t.created_at).slice(0, 10) <= req.query.to_date));
    transactions = await Promise.all(transactions.map(async t => {
      const account = await getOwnedAccount(repo, t.account_id, owners);
      return { ...displayTransaction(t), account_name: account?.account_name || '', account_number: account?.account_number || '' };
    }));
    res.render('transfers/history', { title: 'Transfer History - United Credit Bank', page: 'transfers', transactions, filters: req.query });
  } catch (error) { failClosed(res, req, error); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const owners = sessionOwnerIds(req), t = await repo.get('transactions', req.params.id);
    if (!t || !recordHasOwnerId(t, owners)) { req.session.error = 'Transaction not found.'; return res.redirect('/transfers/history'); }
    const linkedAccount = await repo.get('accounts', t.account_id);
    const account = recordHasOwnerId(linkedAccount, owners) ? linkedAccount : null;
    res.render('transfers/detail', { title: 'Transaction Details - United Credit Bank', page: 'transfers', transaction: { ...displayTransaction(t), account_name: account?.account_name || '', account_number: account?.account_number || '', from_bsb: account?.bsb || '' } });
  } catch (error) { failClosed(res, req, error); }
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const uid = sessionUid(req), owners = sessionOwnerIds(req), id = String(req.params.id), created = nowIso();
    await repo.runTransaction(async tx => {
      const t = await tx.get('transactions', id);
      if (!t || !recordHasOwnerId(t, owners) || t.status !== 'pending') throw new Error('Cannot cancel this transaction.');
      const account = await tx.get('accounts', t.account_id);
      if (!recordHasOwnerId(account, owners)) throw new Error('Cannot cancel this transaction.');
      const refund = readMinorUnits(t, 'amount_minor', 'amount') + readMinorUnits(t, 'fee_minor', 'fee');
      tx.update('accounts', t.account_id, { available_balance_minor: asMinor(account, 'available_balance') + refund, updated_at: created });
      tx.update('transactions', id, { status: 'cancelled', updated_at: created });
      tx.create('ledger_entries', crypto.randomUUID(), { user_id: uid, account_id: t.account_id, transaction_id: id, entry_type: 'release', amount_minor: refund, currency: t.currency || 'AUD', created_at: created, description: 'Pending transfer cancellation release' });
    });
    await addNotification(uid, 'Transfer Cancelled', `Transfer ${id} has been cancelled`, 'info');
    queueTransactionEmail(id, 'This transaction was cancelled.', req.user);
    req.session.success = 'Transfer cancelled successfully.';
    return res.redirect(`/transfers/${id}`);
  } catch (error) {
    if (error.message === 'Cannot cancel this transaction.') { req.session.error = error.message; return res.redirect('/transfers/history'); }
    return failClosed(res, req, error);
  }
});

module.exports = router;
