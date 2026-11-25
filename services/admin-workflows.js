'use strict';

const crypto = require('node:crypto');
const { getRuntimeEnv } = require('../lib/runtime-env');
const { toMinorUnits, readMinorUnits } = require('./money');
const { explicitAdminRole } = require('./authenticated-profile');

const PROFILE_FIELDS = new Set(['first_name', 'last_name', 'phone', 'address', 'city', 'state', 'postcode']);
const ACCOUNT_METADATA_FIELDS = new Set(['account_name', 'branch']);
const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT']);
const ACCOUNT_STATUSES = new Set(['active', 'frozen', 'blocked', 'closed']);
const ACCOUNT_TYPES = new Set([
  'Everyday Savings', 'Everyday Savings Account', 'High Interest Account',
  'Term Deposit Account', 'Business Account', 'Multi-Currency Account'
]);
const OUTGOING_TYPES = new Set(['local_transfer', 'international_transfer', 'withdrawal', 'bill_payment']);
const SETTLEMENT_TYPES = new Set(['deposit', 'local_transfer', 'international_transfer', 'withdrawal', 'bill_payment']);
const LOAN_PRODUCTS = {
  'Personal Loan': { min: 2000, max: 50000, termMin: 12, termMax: 84, rateMin: 6.99, rateMax: 19.99 },
  'Home Loan': { min: 50000, max: 2000000, termMin: 120, termMax: 360, rateMin: 5.49, rateMax: 7.99 },
  'Car Loan': { min: 5000, max: 150000, termMin: 12, termMax: 84, rateMin: 4.99, rateMax: 14.99 },
  'Business Loan': { min: 10000, max: 1000000, termMin: 12, termMax: 120, rateMin: 7.49, rateMax: 22.99 },
  'Education Loan': { min: 1000, max: 100000, termMin: 12, termMax: 120, rateMin: 3.99, rateMax: 9.99 },
  'Line of Credit': { min: 5000, max: 250000, termMin: 12, termMax: 240, rateMin: 8.99, rateMax: 18.99 }
};
const DEFAULT_MAX_ADJUSTMENT_MINOR = 1_000_000; // AUD 10,000
const DEFAULT_MAX_SETTLEMENT_MINOR = 10_000_000; // AUD 100,000

function workflowError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw workflowError('Invalid form submission.');
  return body;
}

function requiredReason(value) {
  if (typeof value !== 'string') throw workflowError('Enter a reason between 8 and 500 characters.');
  const reason = value.trim();
  if (reason.length < 8 || reason.length > 500) throw workflowError('Enter a reason between 8 and 500 characters.');
  return reason;
}

function normalizedString(value, field, { min = 0, max = 160, pattern } = {}) {
  if (typeof value !== 'string') throw workflowError(`Invalid ${field}.`);
  const result = value.trim();
  if (result.length < min || result.length > max) {
    throw workflowError(`${field} must be ${min ? `between ${min} and ` : 'at most '}${max} characters.`);
  }
  if (pattern && result && !pattern.test(result)) throw workflowError(`Invalid ${field}.`);
  return result;
}

function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((key) => key !== '_csrf' && !allowed.has(key));
  if (unknown.length) throw workflowError(`Unsupported field: ${unknown[0]}.`);
}

function normalizeUserProfile(bodyInput) {
  const body = bodyObject(bodyInput);
  rejectUnknownFields(body, new Set([...PROFILE_FIELDS, 'reason']));
  const changes = {};
  if ('first_name' in body) changes.first_name = normalizedString(body.first_name, 'First name', { min: 2, max: 80 });
  if ('last_name' in body) changes.last_name = normalizedString(body.last_name, 'Last name', { min: 2, max: 80 });
  if ('phone' in body) changes.phone = normalizedString(body.phone, 'Phone', { min: 6, max: 30, pattern: /^[+\d][\d\s().-]*$/ });
  if ('address' in body) changes.address = normalizedString(body.address, 'Address', { max: 160 });
  if ('city' in body) changes.city = normalizedString(body.city, 'City', { max: 80 });
  if ('state' in body) {
    changes.state = normalizedString(body.state, 'State', { max: 3 });
    if (changes.state && !AU_STATES.has(changes.state)) throw workflowError('Choose a valid Australian state or territory.');
  }
  if ('postcode' in body) changes.postcode = normalizedString(body.postcode, 'Postcode', { max: 4, pattern: /^\d{4}$/ });
  if (!Object.keys(changes).length) throw workflowError('No profile fields were supplied.');
  return { changes, reason: requiredReason(body.reason) };
}

function normalizeAccountMetadata(bodyInput) {
  const body = bodyObject(bodyInput);
  rejectUnknownFields(body, new Set([...ACCOUNT_METADATA_FIELDS, 'reason']));
  const changes = {};
  if ('account_name' in body) changes.account_name = normalizedString(body.account_name, 'Account name', { min: 2, max: 100 });
  if ('branch' in body) changes.branch = normalizedString(body.branch, 'Branch', { max: 80 });
  if (!Object.keys(changes).length) throw workflowError('No account metadata fields were supplied.');
  return { changes, reason: requiredReason(body.reason) };
}

function normalizeCustomerIdentity(bodyInput) {
  const body = bodyObject(bodyInput);
  const allowed = new Set(['first_name', 'last_name', 'email', 'phone', 'address', 'city', 'state', 'postcode', 'reason']);
  rejectUnknownFields(body, allowed);
  const first_name = normalizedString(body.first_name, 'First name', { min: 2, max: 80 });
  const last_name = normalizedString(body.last_name, 'Last name', { min: 2, max: 80 });
  const email = normalizedString(body.email, 'Email', { min: 5, max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw workflowError('Enter a valid email address.');
  const phone = normalizedString(body.phone, 'Phone', { min: 6, max: 30, pattern: /^[+\d][\d\s().-]*$/ });
  const address = normalizedString(body.address || '', 'Address', { max: 160 });
  const city = normalizedString(body.city || '', 'City', { max: 80 });
  const state = normalizedString(body.state || '', 'State', { max: 3 });
  if (state && !AU_STATES.has(state)) throw workflowError('Choose a valid Australian state or territory.');
  const postcode = normalizedString(body.postcode || '', 'Postcode', { max: 4, pattern: /^\d{4}$/ });
  return { user: { first_name, last_name, email, phone, address, city, state, postcode }, reason: requiredReason(body.reason) };
}

function normalizeAccountCreation(bodyInput) {
  const body = bodyObject(bodyInput);
  rejectUnknownFields(body, new Set(['account_type', 'branch', 'bsb', 'initial_balance', 'reason', 'operation_id']));
  const accountType = normalizedString(body.account_type, 'Account type', { min: 2, max: 80 });
  if (!ACCOUNT_TYPES.has(accountType)) throw workflowError('Choose a supported account type.');
  if (body.initial_balance !== undefined && toMinorUnits(String(body.initial_balance)) !== 0) {
    throw workflowError('An account must open at zero. Record any verified opening deposit as a separate audited ledger operation.');
  }
  const branch = normalizedString(body.branch || '', 'Branch', { max: 80 });
  const bsb = normalizedString(body.bsb || '', 'BSB', { max: 6, pattern: /^\d{6}$/ });
  return { accountType, branch, bsb, reason: requiredReason(body.reason), operationId: requireOperationId(body.operation_id) };
}

function normalizeBalanceAdjustment(bodyInput, maxAmountMinor) {
  const body = bodyObject(bodyInput);
  rejectUnknownFields(body, new Set(['account_id', 'adjustment_type', 'type', 'amount', 'reason', 'notes', 'reference', 'case_reference', 'operation_id']));
  const accountId = requireId(body.account_id, 'account id');
  const adjustmentType = normalizedString(body.adjustment_type || body.type, 'Adjustment type', { min: 1, max: 12 }).toLowerCase();
  if (!['credit', 'debit'].includes(adjustmentType)) throw workflowError('Choose credit or debit.');
  let amountMinor;
  try { amountMinor = toMinorUnits(String(body.amount ?? '')); } catch (error) { throw workflowError(error.message); }
  if (amountMinor <= 0) throw workflowError('Enter a positive adjustment amount.');
  if (amountMinor > maxAmountMinor) throw workflowError(`Adjustment exceeds the current per-operation limit of ${maxAmountMinor / 100}.`);
  const reason = requiredReason(body.reason || body.notes);
  const reference = normalizedString(body.reference || body.case_reference || '', 'Supporting reference', { min: 3, max: 120, pattern: /^[A-Za-z0-9._:/-]+$/ });
  return { accountId, adjustmentType, amountMinor, reason, reference, operationId: requireOperationId(body.operation_id) };
}

function normalizeReview(bodyInput, action, { requireSettlement = false } = {}) {
  const body = bodyObject(bodyInput);
  rejectUnknownFields(body, new Set(['reason', 'settlement_reference', 'account_id', 'operation_id']));
  if (!['approve', 'reject'].includes(action)) throw workflowError('Choose approve or reject.');
  const reason = requiredReason(body.reason);
  const settlementReference = action === 'approve'
    ? normalizedString(body.settlement_reference || '', 'Settlement reference', { min: requireSettlement ? 3 : 0, max: 120, pattern: /^[A-Za-z0-9._:/-]+$/ })
    : '';
  return { reason, settlementReference, accountId: body.account_id ? requireId(body.account_id, 'account id') : '' };
}

function requireId(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 150 || id.includes('/')) throw workflowError(`Invalid ${label}.`);
  return id;
}

function requireOperationId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(id)) throw workflowError('This form has expired. Reload it and try again.');
  return id;
}

function requireActor(actorId) {
  const id = String(actorId || '').trim();
  if (!id) throw workflowError('Verified administrator identity is required.', 403);
  return id;
}

function boolFlag(value) {
  return value === true || Number(value) === 1;
}

async function requireCurrentAdmin(tx, actorId) {
  const userProfile = await tx.get('users', actorId);
  const adminProfile = await tx.get('admins', actorId);
  if (adminProfile) {
    const role = explicitAdminRole(adminProfile);
    const blocked = boolFlag(adminProfile.disabled) || boolFlag(adminProfile.is_frozen)
      || boolFlag(userProfile && userProfile.disabled) || boolFlag(userProfile && userProfile.is_frozen);
    if (adminProfile.active !== true || !role || blocked) {
      throw workflowError('Administrator permissions are no longer active.', 403);
    }
    return {
      ...(userProfile || {}),
      ...adminProfile,
      id: actorId,
      role,
      is_admin: 1,
      is_super_admin: role === 'super_admin'
    };
  }

  const actor = userProfile;
  const isAdmin = actor && (boolFlag(actor.is_admin) || actor.is_super_admin === true || actor.role === 'admin' || actor.role === 'super_admin');
  if (!isAdmin || boolFlag(actor.disabled) || boolFlag(actor.is_frozen)) {
    throw workflowError('Administrator permissions are no longer active.', 403);
  }
  return actor;
}

function makeAudit({ actorId, action, targetType, targetId, details, ipAddress, createdAt }) {
  return {
    admin_id: String(actorId), action, target_type: targetType, target_id: String(targetId),
    details: JSON.stringify(details), ip_address: String(ipAddress || '').slice(0, 128), created_at: createdAt
  };
}

function makeNotification({ userId, title, message, type = 'info', createdAt, idFactory }) {
  return { id: idFactory(), user_id: String(userId), title, message, type, is_read: false, created_at: createdAt };
}

function safeMinor(record, minorField, legacyField, fallback = 0) {
  try { return readMinorUnits(record, minorField, legacyField, fallback); }
  catch (error) { throw workflowError(error.message, 409); }
}

function configuredLimit(name, fallback) {
  const raw = getRuntimeEnv(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw workflowError(`${name} must be a positive integer in minor units.`, 503);
  return value;
}

function requestHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function getExistingOperation(tx, { operationId, actorId, action, request }) {
  const existing = await tx.get('admin_operations', operationId);
  if (!existing) return null;
  if (existing.actor_id !== actorId || existing.action !== action || existing.request_hash !== requestHash(request)) {
    throw workflowError('This operation reference was already used for a different request.', 409);
  }
  return { ...(existing.result || {}), replayed: true };
}

function createOperation(tx, { operationId, actorId, action, targetId, request, result, createdAt }) {
  tx.create('admin_operations', operationId, {
    actor_id: actorId, action, target_id: String(targetId), request_hash: requestHash(request),
    result, created_at: createdAt
  });
}

function accountMoney(account) {
  const balanceMinor = safeMinor(account, 'balance_minor', 'balance');
  const availableMinor = safeMinor(account, 'available_balance_minor', 'available_balance', balanceMinor);
  if (balanceMinor < 0 || availableMinor < 0 || availableMinor > balanceMinor) {
    throw workflowError('Account balances require reconciliation before this operation.', 409);
  }
  return { balanceMinor, availableMinor };
}

function randomAccountNumber() {
  return `20${String(crypto.randomInt(0, 1_000_000_000)).padStart(9, '0')}`;
}

function monthAfter(dateString) {
  const input = new Date(dateString);
  if (!Number.isFinite(input.getTime())) throw workflowError('Invalid loan approval time.', 500);
  const day = input.getUTCDate();
  const next = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth() + 1, 1));
  const daysInMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, daysInMonth));
  return next.toISOString().slice(0, 10);
}

function transactionAmount(transaction) {
  const amountMinor = safeMinor(transaction, 'amount_minor', 'amount');
  const feeMinor = safeMinor(transaction, 'fee_minor', 'fee');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || feeMinor < 0) {
    throw workflowError('Transaction amount or fee requires reconciliation.', 409);
  }
  if (!Number.isSafeInteger(amountMinor + feeMinor)) throw workflowError('Transaction amount exceeds the supported range.', 409);
  return { amountMinor, feeMinor, totalMinor: amountMinor + feeMinor };
}

function reservedAmount(transaction, ledgerEntries, totalMinor, amountMinor) {
  if (Object.prototype.hasOwnProperty.call(transaction, 'reserved_minor')) {
    const reserved = safeMinor(transaction, 'reserved_minor', 'reserved');
    if (reserved < 0 || reserved > totalMinor) throw workflowError('Transaction reservation requires reconciliation.', 409);
    return reserved;
  }
  let match = null;
  if (transaction.transaction_type === 'local_transfer') {
    match = ledgerEntries.find((entry) => entry.entry_type === 'debit' && safeMinor(entry, 'amount_minor', 'amount') === totalMinor);
  } else if (transaction.transaction_type === 'international_transfer') {
    match = ledgerEntries.find((entry) => entry.entry_type === 'hold' && safeMinor(entry, 'amount_minor', 'amount') === totalMinor);
  } else if (transaction.transaction_type === 'withdrawal') {
    match = ledgerEntries.find((entry) => entry.entry_type === 'withdrawal' && safeMinor(entry, 'amount_minor', 'amount') === -amountMinor);
  }
  return match ? totalMinor : 0;
}

function assertActiveAccount(account, action) {
  const status = String(account.status || 'active').toLowerCase();
  if (status !== 'active') throw workflowError(`This account is ${status} and cannot be used to ${action}.`, 409);
}

async function findBillForTransaction(tx, transaction) {
  if (transaction.bill_payment_id) {
    const linked = await tx.get('bill_payments', String(transaction.bill_payment_id));
    if (!linked) throw workflowError('The linked bill-payment record is missing; review the records before retrying.', 409);
    return linked;
  }
  const candidates = await tx.list('bill_payments', [{ field: 'user_id', value: String(transaction.user_id) }], { limit: 1000 });
  if (candidates.length >= 1000) throw workflowError('Bill-payment matching requires a manual record review.', 409);
  const { amountMinor } = transactionAmount(transaction);
  const matches = candidates.filter((bill) => String(bill.account_id) === String(transaction.account_id) && bill.status === 'pending' && safeMinor(bill, 'amount_minor', 'amount') === amountMinor);
  if (matches.length !== 1) throw workflowError('A unique bill-payment record could not be matched to this transaction.', 409);
  return matches[0];
}

async function findTransactionForBill(tx, bill) {
  if (bill.transaction_id) {
    const linked = await tx.get('transactions', String(bill.transaction_id));
    if (!linked) throw workflowError('The linked transaction record is missing; review the records before retrying.', 409);
    return linked;
  }
  const candidates = await tx.list('transactions', [{ field: 'user_id', value: String(bill.user_id) }], { limit: 1000 });
  if (candidates.length >= 1000) throw workflowError('Transaction matching requires a manual record review.', 409);
  const billAmount = safeMinor(bill, 'amount_minor', 'amount');
  const matches = candidates.filter((transaction) => String(transaction.account_id) === String(bill.account_id) && transaction.transaction_type === 'bill_payment' && transaction.status === 'pending' && safeMinor(transaction, 'amount_minor', 'amount') === billAmount);
  if (matches.length !== 1) throw workflowError('A unique transaction could not be matched to this bill payment.', 409);
  return matches[0];
}

function createAdminWorkflows(repo, { clock = () => new Date().toISOString(), idFactory = () => crypto.randomUUID() } = {}) {
  if (!repo || typeof repo.runTransaction !== 'function') throw new TypeError('A Firestore repository is required.');

  return {
    async updateUserProfile({ actorId, targetId, body, ipAddress }) {
      const actor = requireActor(actorId);
      const target = requireId(targetId, 'user id');
      const { changes, reason } = normalizeUserProfile(body);
      const createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const user = await tx.get('users', target);
        if (!user) throw workflowError('Customer not found.', 404);
        if (boolFlag(user.is_admin) || user.role === 'admin') throw workflowError('Administrator profiles cannot be edited through customer controls.', 409);
        tx.update('users', target, { ...changes, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({
          actorId: actor, action: 'update_user_profile', targetType: 'user', targetId: target,
          details: { changed_fields: Object.keys(changes).sort(), reason }, ipAddress, createdAt
        }));
        tx.create('notifications', idFactory(), makeNotification({
          userId: target, title: 'Account details updated', message: 'Your account profile details were updated by an administrator.', type: 'info', createdAt, idFactory
        }));
        return { changed: true, changedFields: Object.keys(changes).sort() };
      });
      return result.result;
    },

    async setUserFrozen({ actorId, targetId, action, reason: reasonInput, ipAddress }) {
      const actor = requireActor(actorId);
      const target = requireId(targetId, 'user id');
      const reason = requiredReason(reasonInput);
      if (!['freeze', 'unfreeze'].includes(action)) throw workflowError('Choose freeze or unfreeze.');
      const freeze = action === 'freeze';
      if (freeze && actor === target) throw workflowError('You cannot freeze your own administrator account.', 409);
      const createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const user = await tx.get('users', target);
        if (!user) throw workflowError('Customer not found.', 404);
        if (boolFlag(user.is_admin) || user.role === 'admin' || user.role === 'super_admin') throw workflowError('Administrator accounts cannot be frozen through customer controls.', 409);
        if (boolFlag(user.disabled) && !freeze) throw workflowError('Disabled customers must be restored through the audited restore action.', 409);
        const wasFrozen = boolFlag(user.is_frozen);
        if (wasFrozen === freeze) return { changed: false };
        tx.update('users', target, { is_frozen: freeze ? 1 : 0, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({
          actorId: actor, action: freeze ? 'freeze_user' : 'unfreeze_user', targetType: 'user', targetId: target,
          details: { previous: wasFrozen ? 'frozen' : 'active', next: freeze ? 'frozen' : 'active', reason }, ipAddress, createdAt
        }));
        tx.create('notifications', idFactory(), makeNotification({
          userId: target, title: freeze ? 'Account frozen' : 'Account unfrozen',
          message: freeze ? `Your account access has been frozen. Reason: ${reason}` : 'Your account access has been restored.',
          type: freeze ? 'warning' : 'success', createdAt, idFactory
        }));
        return { changed: true, frozen: freeze };
      });
      return result.result;
    },

    async disableCustomer({ actorId, targetId, reason: reasonInput, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(targetId, 'user id'), reason = requiredReason(reasonInput), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const user = await tx.get('users', target);
        if (!user) throw workflowError('Customer not found.', 404);
        if (boolFlag(user.is_admin) || user.role === 'admin' || user.role === 'super_admin') throw workflowError('Administrator accounts cannot be disabled through customer controls.', 409);
        if (boolFlag(user.disabled)) return { changed: false };
        tx.update('users', target, { disabled: true, is_frozen: 1, disabled_at: createdAt, disabled_reason: reason, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'disable_customer', targetType: 'user', targetId: target, details: { reason, financial_history_retained: true }, ipAddress, createdAt }));
        tx.create('notifications', idFactory(), makeNotification({ userId: target, title: 'Account access disabled', message: 'Your account access has been disabled. Contact support for assistance.', type: 'warning', createdAt, idFactory }));
        return { changed: true };
      });
      return result.result;
    },

    async restoreCustomer({ actorId, targetId, reason: reasonInput, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(targetId, 'user id'), reason = requiredReason(reasonInput), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const user = await tx.get('users', target);
        if (!user) throw workflowError('Customer not found.', 404);
        if (boolFlag(user.is_admin) || user.role === 'admin' || user.role === 'super_admin') throw workflowError('Administrator accounts cannot be restored through customer controls.', 409);
        if (!boolFlag(user.disabled)) return { changed: false };
        tx.update('users', target, { disabled: false, is_frozen: 0, disabled_at: null, disabled_reason: null, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'restore_customer', targetType: 'user', targetId: target, details: { reason, financial_history_retained: true }, ipAddress, createdAt }));
        tx.create('notifications', idFactory(), makeNotification({ userId: target, title: 'Account access restored', message: 'Your account access has been restored. Contact support if you need help signing in.', type: 'success', createdAt, idFactory }));
        return { changed: true };
      });
      return result.result;
    },

    async recordPasswordResetRequest({ actorId, targetId, reason: reasonInput, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(targetId, 'user id'), reason = requiredReason(reasonInput), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const user = await tx.get('users', target);
        if (!user) throw workflowError('Customer not found.', 404);
        if (boolFlag(user.is_admin) || user.role === 'admin' || user.role === 'super_admin') throw workflowError('Administrator password resets must use the verified administrator recovery process.', 409);
        if (!user.email || typeof user.email !== 'string') throw workflowError('Customer email is missing from the Firebase profile.', 409);
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'request_password_reset', targetType: 'user', targetId: target, details: { reason, delivery: 'Firebase password-reset email requested' }, ipAddress, createdAt }));
        return { email: user.email };
      });
      return result.result;
    },

    async createCustomer({ actorId, userId, body, ipAddress }) {
      const actor = requireActor(actorId), uid = requireId(userId, 'Firebase user id');
      const { user, reason } = normalizeCustomerIdentity(body);
      const createdAt = clock(), accountId = idFactory(), ledgerId = idFactory(), auditId = idFactory(), notificationId = idFactory();
      const accountNumber = randomAccountNumber();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const duplicate = await tx.list('users', [{ field: 'email', value: user.email }], { limit: 1 });
        if (duplicate.length) throw workflowError('A Firestore customer record with this email already exists.', 409);
        if (await tx.get('users', uid)) throw workflowError('A Firestore profile already exists for this Firebase identity.', 409);
        const numberExists = await tx.list('accounts', [{ field: 'account_number', value: accountNumber }], { limit: 1 });
        if (numberExists.length) throw workflowError('Could not allocate a unique account number. Reload and try again.', 503);
        const profile = {
          id: uid, ...user, is_admin: 0, is_verified: 0, is_frozen: 0, disabled: false,
          role: 'customer', created_at: createdAt, updated_at: createdAt, created_by_admin_id: actor
        };
        const account = {
          user_id: uid, account_number: accountNumber, account_type: 'Everyday Savings',
          account_name: `${user.first_name} ${user.last_name}`.trim(), status: 'active', currency: 'AUD',
          balance_minor: 0, available_balance_minor: 0, branch: '', bsb: '', created_at: createdAt, updated_at: createdAt
        };
        tx.create('users', uid, profile);
        tx.create('accounts', accountId, account);
        tx.create('ledger_entries', ledgerId, {
          user_id: uid, account_id: accountId, amount_minor: 0, balance_after_minor: 0,
          entry_type: 'account_opening', status: 'completed', currency: 'AUD', description: 'Account opened at zero balance', created_at: createdAt
        });
        tx.create('audit_logs', auditId, makeAudit({ actorId: actor, action: 'create_customer', targetType: 'user', targetId: uid, details: { account_id: accountId, reason, kyc_created: false }, ipAddress, createdAt }));
        tx.create('notifications', notificationId, makeNotification({ userId: uid, title: 'Account created', message: 'Your United Credit Bank customer profile and zero-balance account are ready. Set your password using the email link.', type: 'info', createdAt, idFactory: () => notificationId }));
        return { changed: true, userId: uid, accountId, accountNumber };
      });
      return result.result;
    },

    async createAdminUser({ actorId, userId, body, ipAddress }) {
      const actor = requireActor(actorId), uid = requireId(userId, 'Firebase user id');
      const { user, reason } = normalizeCustomerIdentity(body);
      const createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const duplicate = await tx.list('users', [{ field: 'email', value: user.email }], { limit: 1 });
        if (duplicate.length) throw workflowError('A profile with this email already exists; administrator promotion is not available here.', 409);
        if (await tx.get('users', uid)) throw workflowError('A Firestore profile already exists for this Firebase identity.', 409);
        tx.create('users', uid, {
          id: uid, ...user, is_admin: 1, is_verified: 0, is_frozen: 0, disabled: false,
          role: 'admin', created_at: createdAt, updated_at: createdAt, created_by_admin_id: actor
        });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'create_admin', targetType: 'user', targetId: uid, details: { reason, invitation_allowlist_required: true }, ipAddress, createdAt }));
        return { changed: true, userId: uid };
      });
      return result.result;
    },

    async createAccount({ actorId, targetId, body, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(targetId, 'user id');
      const { accountType, branch, bsb, reason, operationId } = normalizeAccountCreation(body);
      const createdAt = clock();
      const request = { actor, target, accountType, branch, bsb, reason };
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const replay = await getExistingOperation(tx, { operationId, actorId: actor, action: 'create_account', request });
        if (replay) return replay;
        const user = await tx.get('users', target);
        if (!user) throw workflowError('Customer not found.', 404);
        if (boolFlag(user.disabled) || boolFlag(user.is_admin) || user.role === 'admin') throw workflowError('An active customer is required to open an account.', 409);
        const accountId = idFactory(), ledgerId = idFactory(), auditId = idFactory(), notificationId = idFactory();
        let accountNumber = '';
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const candidate = randomAccountNumber();
          const matches = await tx.list('accounts', [{ field: 'account_number', value: candidate }], { limit: 1 });
          if (!matches.length) { accountNumber = candidate; break; }
        }
        if (!accountNumber) throw workflowError('Could not allocate a unique account number. Try again.', 503);
        tx.create('accounts', accountId, {
          user_id: target, account_number: accountNumber, account_type: accountType,
          account_name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || accountType,
          status: 'active', currency: 'AUD', branch, bsb, interest_rate: 0,
          balance_minor: 0, available_balance_minor: 0, created_at: createdAt, updated_at: createdAt
        });
        tx.create('ledger_entries', ledgerId, {
          user_id: target, account_id: accountId, amount_minor: 0, balance_after_minor: 0,
          entry_type: 'account_opening', status: 'completed', currency: 'AUD', description: 'Account opened at zero balance', created_at: createdAt
        });
        tx.create('audit_logs', auditId, makeAudit({ actorId: actor, action: 'create_account', targetType: 'account', targetId: accountId, details: { user_id: target, account_type: accountType, reason, initial_balance_minor: 0 }, ipAddress, createdAt }));
        tx.create('notifications', notificationId, makeNotification({ userId: target, title: 'New account opened', message: `A ${accountType} account has been opened for you.`, type: 'success', createdAt, idFactory: () => notificationId }));
        const value = { changed: true, accountId, accountNumber };
        createOperation(tx, { operationId, actorId: actor, action: 'create_account', targetId: accountId, request, result: value, createdAt });
        return value;
      });
      return result.result;
    },

    async adjustAccountBalance({ actorId, accountId, body, ipAddress }) {
      const actor = requireActor(actorId);
      const maxAmountMinor = configuredLimit('ADMIN_MAX_ADJUSTMENT_MINOR', DEFAULT_MAX_ADJUSTMENT_MINOR);
      const { accountId: target, adjustmentType, amountMinor, reason, reference, operationId } = normalizeBalanceAdjustment(body, maxAmountMinor);
      const createdAt = clock();
      const request = { actor, target, adjustmentType, amountMinor, reason, reference };
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const replay = await getExistingOperation(tx, { operationId, actorId: actor, action: 'adjust_account_balance', request });
        if (replay) return replay;
        const account = await tx.get('accounts', target);
        if (!account) throw workflowError('Account not found.', 404);
        assertActiveAccount(account, 'receive an administrative balance adjustment');
        const { balanceMinor, availableMinor } = accountMoney(account);
        const direction = adjustmentType === 'credit' ? 1 : -1;
        if (direction < 0 && amountMinor > availableMinor) throw workflowError('Debit exceeds the available balance.', 409);
        const deltaMinor = direction * amountMinor;
        const newBalanceMinor = balanceMinor + deltaMinor;
        const newAvailableMinor = availableMinor + deltaMinor;
        if (!Number.isSafeInteger(newBalanceMinor) || !Number.isSafeInteger(newAvailableMinor) || newBalanceMinor < 0 || newAvailableMinor < 0) {
          throw workflowError('The adjustment would exceed supported account balance limits.', 409);
        }
        const transactionId = idFactory(), ledgerId = idFactory(), auditId = idFactory(), notificationId = idFactory();
        const currency = String(account.currency || 'AUD').toUpperCase();
        tx.update('accounts', target, { balance_minor: newBalanceMinor, available_balance_minor: newAvailableMinor, updated_at: createdAt });
        tx.create('transactions', transactionId, {
          user_id: String(account.user_id), account_id: target, transaction_type: 'admin_adjustment', amount_minor: deltaMinor,
          currency, description: `Administrator ${adjustmentType}: ${reason.slice(0, 160)}`, reference, status: 'completed',
          approved_by: actor, approved_at: createdAt, created_at: createdAt, updated_at: createdAt
        });
        tx.create('ledger_entries', ledgerId, {
          user_id: String(account.user_id), account_id: target, transaction_id: transactionId,
          entry_type: `admin_adjustment_${adjustmentType}`, amount_minor: deltaMinor,
          balance_after_minor: newBalanceMinor, available_after_minor: newAvailableMinor,
          currency, status: 'completed', reference, description: reason, created_at: createdAt
        });
        tx.create('audit_logs', auditId, makeAudit({ actorId: actor, action: `balance_${adjustmentType}`, targetType: 'account', targetId: target, details: { transaction_id: transactionId, amount_minor: amountMinor, currency, reason, reference }, ipAddress, createdAt }));
        tx.create('notifications', notificationId, makeNotification({ userId: String(account.user_id), title: 'Account balance adjusted', message: `An administrator ${adjustmentType === 'credit' ? 'credited' : 'debited'} your account.`, type: adjustmentType === 'credit' ? 'success' : 'info', createdAt, idFactory: () => notificationId }));
        const value = { changed: true, transactionId, balanceMinor: newBalanceMinor };
        createOperation(tx, { operationId, actorId: actor, action: 'adjust_account_balance', targetId: target, request, result: value, createdAt });
        return value;
      });
      return result.result;
    },

    async changeAccountStatus({ actorId, accountId, status: requestedStatus, reason: reasonInput, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(accountId, 'account id');
      if (typeof requestedStatus !== 'string') throw workflowError('Choose active, frozen, blocked, or closed status.');
      const status = requestedStatus.trim().toLowerCase(), reason = requiredReason(reasonInput);
      if (!ACCOUNT_STATUSES.has(status)) throw workflowError('Choose active, frozen, blocked, or closed status.');
      const createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const account = await tx.get('accounts', target);
        if (!account) throw workflowError('Account not found.', 404);
        const previous = String(account.status || 'active').toLowerCase();
        if (previous === 'closed') {
          if (status === 'closed') return { changed: false, status };
          throw workflowError('Closed accounts cannot be reactivated or edited.', 409);
        }
        if (!['active', 'frozen', 'blocked'].includes(previous)) throw workflowError('This legacy account status requires review before changing.', 409);
        if (previous === status) return { changed: false, status };
        if (status === 'closed') {
          const { balanceMinor, availableMinor } = accountMoney(account);
          const [accountTransactions, accountBills] = await Promise.all([
            tx.list('transactions', [{ field: 'account_id', value: target }], { limit: 1000 }),
            tx.list('bill_payments', [{ field: 'account_id', value: target }], { limit: 1000 })
          ]);
          if (accountTransactions.length >= 1000 || accountBills.length >= 1000) throw workflowError('Account closure requires a manual transaction-history review.', 409);
          const pendingTransactions = accountTransactions.filter((item) => item.status === 'pending');
          const pendingBills = accountBills.filter((item) => item.status === 'pending');
          if (balanceMinor !== 0 || availableMinor !== 0) throw workflowError('Account closure requires zero balance and zero available balance.', 409);
          if (pendingTransactions.length || pendingBills.length) throw workflowError('Resolve pending transactions and bill payments before closing this account.', 409);
        }
        tx.update('accounts', target, { status, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'change_account_status', targetType: 'account', targetId: target, details: { previous, next: status, reason }, ipAddress, createdAt }));
        tx.create('notifications', idFactory(), makeNotification({ userId: String(account.user_id), title: 'Account status updated', message: `Your account status is now ${status}.`, type: status === 'active' ? 'success' : 'warning', createdAt, idFactory }));
        return { changed: true, previous, status };
      });
      return result.result;
    },

    async updateAccountMetadata({ actorId, accountId, body, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(accountId, 'account id');
      const { changes, reason } = normalizeAccountMetadata(body), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const account = await tx.get('accounts', target);
        if (!account) throw workflowError('Account not found.', 404);
        if (String(account.status || '').toLowerCase() === 'closed') throw workflowError('Closed accounts cannot be edited.', 409);
        tx.update('accounts', target, { ...changes, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'update_account_metadata', targetType: 'account', targetId: target, details: { changed_fields: Object.keys(changes).sort(), reason }, ipAddress, createdAt }));
        return { changed: true, changedFields: Object.keys(changes).sort() };
      });
      return result.result;
    },

    async reviewKyc({ actorId, recordId, action, body, ipAddress, documentEvidence }) {
      const actor = requireActor(actorId), target = requireId(recordId, 'KYC id');
      const { reason } = normalizeReview(body, action), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const record = await tx.get('kyc', target);
        if (!record) throw workflowError('KYC record not found.', 404);
        if (record.status !== 'pending') throw workflowError('KYC record is no longer pending review.', 409);
        const userId = requireId(record.user_id, 'customer id');
        const user = await tx.get('users', userId);
        if (!user) throw workflowError('The customer profile for this KYC record is missing.', 409);
        if (boolFlag(user.disabled)) throw workflowError('Disabled customer KYC records cannot be approved.', 409);
        if (action === 'approve') {
          const requiresBack = ['Drivers Licence', 'Proof of Age', 'Medicare'].includes(String(record.document_type || ''));
          const fields = ['document_front', ...(requiresBack ? ['document_back'] : []), ...(record.document_selfie ? ['document_selfie'] : [])];
          for (const field of fields) {
            const objectName = String(record[field] || '');
            if (!objectName.startsWith(`kyc/${userId}/`) || !documentEvidence || documentEvidence[field] !== objectName) {
              throw workflowError('Open and verify the submitted identity files before approving this KYC record.', 409);
            }
          }
        }
        let verified = action === 'approve';
        if (action === 'reject') {
          const userRecords = await tx.list('kyc', [{ field: 'user_id', value: userId }], { limit: 1000 });
          if (userRecords.length >= 1000) throw workflowError('KYC history requires manual review.', 409);
          const otherApproved = userRecords.filter((item) => item.status === 'approved');
          verified = otherApproved.length > 0;
        }
        const changes = {
          status: action === 'approve' ? 'approved' : 'rejected', reviewed_by: actor,
          reviewed_at: createdAt, review_notes: reason, updated_at: createdAt
        };
        if (action === 'approve') changes.rejection_reason = '';
        else changes.rejection_reason = reason;
        tx.update('kyc', target, changes);
        tx.update('users', userId, { is_verified: verified ? 1 : 0, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: action === 'approve' ? 'approve_kyc' : 'reject_kyc', targetType: 'kyc', targetId: target, details: { user_id: userId, document_type: String(record.document_type || ''), previous: 'pending', next: changes.status, reason }, ipAddress, createdAt }));
        tx.create('notifications', idFactory(), makeNotification({ userId, title: action === 'approve' ? 'Identity verification approved' : 'Identity verification needs attention', message: action === 'approve' ? 'Your submitted identity verification was approved.' : `Your identity verification was not approved: ${reason}`, type: action === 'approve' ? 'success' : 'warning', createdAt, idFactory }));
        return { changed: true, status: changes.status, verified };
      });
      return result.result;
    },

    async reviewTransaction({ actorId, transactionId, billPaymentId, action, body, ipAddress }) {
      const actor = requireActor(actorId);
      const targetTransactionId = transactionId ? requireId(transactionId, 'transaction id') : '';
      const targetBillId = billPaymentId ? requireId(billPaymentId, 'bill-payment id') : '';
      if (!targetTransactionId && !targetBillId) throw workflowError('Transaction or bill-payment id is required.');
      const { reason, settlementReference } = normalizeReview(body, action, { requireSettlement: action === 'approve' });
      const createdAt = clock();
      const maxSettlementMinor = configuredLimit('ADMIN_MAX_SETTLEMENT_MINOR', DEFAULT_MAX_SETTLEMENT_MINOR);
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        let bill = targetBillId ? await tx.get('bill_payments', targetBillId) : null;
        if (targetBillId && !bill) throw workflowError('Bill payment not found.', 404);
        let transaction = targetTransactionId ? await tx.get('transactions', targetTransactionId) : null;
        if (targetTransactionId && !transaction) throw workflowError('Transaction not found.', 404);
        if (!transaction && bill) transaction = await findTransactionForBill(tx, bill);
        if (!transaction) throw workflowError('Transaction not found.', 404);
        if (transaction.status !== 'pending') throw workflowError('Transaction is no longer pending review.', 409);
        if (transaction.transaction_type === 'bill_payment' && !bill) bill = await findBillForTransaction(tx, transaction);
        if (bill) {
          if (bill.status !== 'pending') throw workflowError('Bill payment is no longer pending review.', 409);
          if (String(bill.user_id) !== String(transaction.user_id) || String(bill.account_id) !== String(transaction.account_id)) throw workflowError('Bill and transaction ownership do not match.', 409);
          if (safeMinor(bill, 'amount_minor', 'amount') !== transactionAmount(transaction).amountMinor) throw workflowError('Bill and transaction amounts do not match.', 409);
        }
        const userId = requireId(transaction.user_id, 'customer id');
        const accountId = requireId(transaction.account_id, 'account id');
        const [user, account, ledgerEntries] = await Promise.all([
          tx.get('users', userId), tx.get('accounts', accountId),
          tx.list('ledger_entries', [{ field: 'transaction_id', value: String(transaction.id || targetTransactionId) }], { limit: 100 })
        ]);
        if (!user || boolFlag(user.disabled)) throw workflowError('Customer record is unavailable.', 409);
        if (!account || String(account.user_id) !== userId) throw workflowError('Transaction account ownership could not be confirmed.', 409);
        const type = String(transaction.transaction_type || '');
        if (!SETTLEMENT_TYPES.has(type)) throw workflowError('This transaction type cannot be approved through the settlement workflow.', 409);
        const { amountMinor, feeMinor, totalMinor } = transactionAmount(transaction);
        if (action === 'approve' && totalMinor > maxSettlementMinor) throw workflowError(`Settlement exceeds the current per-operation limit of ${maxSettlementMinor / 100}.`, 409);
        const { balanceMinor, availableMinor } = accountMoney(account);
        const accountStatus = String(account.status || 'active').toLowerCase();
        const reservedMinor = OUTGOING_TYPES.has(type) ? reservedAmount(transaction, ledgerEntries, totalMinor, amountMinor) : 0;
        let nextBalanceMinor = balanceMinor;
        let nextAvailableMinor = availableMinor;
        let finalStatus;
        let ledgerType;
        let ledgerAmountMinor = 0;
        if (action === 'approve') {
          if (accountStatus === 'closed' || !['active', 'frozen', 'blocked'].includes(accountStatus)) throw workflowError('Account status requires review before settlement.', 409);
          if (OUTGOING_TYPES.has(type)) {
            assertActiveAccount(account, 'settle this transaction');
            if (totalMinor > balanceMinor) throw workflowError('The account balance is insufficient to settle this transaction.', 409);
            const unreservedMinor = totalMinor - reservedMinor;
            if (unreservedMinor > availableMinor) throw workflowError('The available balance is insufficient to settle this transaction.', 409);
            nextBalanceMinor = balanceMinor - totalMinor;
            nextAvailableMinor = availableMinor - unreservedMinor;
            ledgerAmountMinor = -totalMinor;
          } else {
            nextBalanceMinor = balanceMinor + amountMinor;
            nextAvailableMinor = accountStatus === 'active' ? availableMinor + amountMinor : availableMinor;
            ledgerAmountMinor = amountMinor;
          }
          if (!Number.isSafeInteger(nextBalanceMinor) || !Number.isSafeInteger(nextAvailableMinor) || nextAvailableMinor > nextBalanceMinor) throw workflowError('The settlement would leave account balances inconsistent.', 409);
          finalStatus = 'completed';
          ledgerType = type === 'deposit' ? 'deposit_settlement' : `${type}_settlement`;
        } else {
          if (reservedMinor) {
            nextAvailableMinor = availableMinor + reservedMinor;
            if (!Number.isSafeInteger(nextAvailableMinor) || nextAvailableMinor > balanceMinor) throw workflowError('The reservation release requires account reconciliation.', 409);
          }
          finalStatus = 'rejected';
          ledgerType = reservedMinor ? 'hold_release' : 'transaction_rejection';
          ledgerAmountMinor = reservedMinor;
        }
        const transactionChanges = {
          status: finalStatus, reviewed_by: actor, reviewed_at: createdAt,
          review_reason: reason, updated_at: createdAt,
          reservation_status: action === 'approve' ? 'settled' : (reservedMinor ? 'released' : 'none')
        };
        if (action === 'approve') Object.assign(transactionChanges, { approved_by: actor, approved_at: createdAt, settlement_reference: settlementReference });
        else transactionChanges.rejection_reason = reason;
        if (bill) transactionChanges.bill_payment_id = String(bill.id || targetBillId);
        tx.update('accounts', accountId, { balance_minor: nextBalanceMinor, available_balance_minor: nextAvailableMinor, updated_at: createdAt });
        tx.update('transactions', String(transaction.id || targetTransactionId), transactionChanges);
        tx.create('ledger_entries', idFactory(), {
          user_id: userId, account_id: accountId, transaction_id: String(transaction.id || targetTransactionId),
          entry_type: ledgerType, amount_minor: ledgerAmountMinor,
          ...(reservedMinor && action === 'reject' ? { release_minor: reservedMinor } : {}),
          balance_after_minor: nextBalanceMinor, available_after_minor: nextAvailableMinor,
          currency: String(transaction.currency || account.currency || 'AUD'), status: finalStatus,
          reference: action === 'approve' ? settlementReference : '', description: reason, created_at: createdAt
        });
        if (bill) tx.update('bill_payments', String(bill.id || targetBillId), {
          status: action === 'approve' ? 'completed' : 'rejected',
          ...(action === 'approve' ? { approved_by: actor, approved_at: createdAt, settlement_reference: settlementReference } : { rejection_reason: reason }),
          transaction_id: String(transaction.id || targetTransactionId), updated_at: createdAt
        });
        tx.create('audit_logs', idFactory(), makeAudit({
          actorId: actor, action: action === 'approve' ? 'approve_transaction' : 'reject_transaction',
          targetType: bill ? 'bill_payment' : 'transaction', targetId: bill ? String(bill.id || targetBillId) : String(transaction.id || targetTransactionId),
          details: { transaction_id: String(transaction.id || targetTransactionId), transaction_type: type, amount_minor: amountMinor, fee_minor: feeMinor, final_status: finalStatus, settlement_reference: action === 'approve' ? settlementReference : '', reservation_released_minor: action === 'reject' ? reservedMinor : 0, reason },
          ipAddress, createdAt
        }));
        tx.create('notifications', idFactory(), makeNotification({
          userId, title: action === 'approve' ? 'Transaction approved' : 'Transaction rejected',
          message: action === 'approve' ? `Your ${type.replace(/_/g, ' ')} transaction was approved and recorded.` : `Your ${type.replace(/_/g, ' ')} transaction was rejected: ${reason}`,
          type: action === 'approve' ? 'success' : 'warning', createdAt, idFactory
        }));
        return { changed: true, transactionId: String(transaction.id || targetTransactionId), status: finalStatus, billPaymentId: bill ? String(bill.id || targetBillId) : null };
      });
      return result.result;
    },

    async reviewCard({ actorId, cardId, action, body, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(cardId, 'card id');
      const { reason } = normalizeReview(body, action), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const card = await tx.get('cards', target);
        if (!card) throw workflowError('Card application not found.', 404);
        if (card.status !== 'pending') throw workflowError('Card application is no longer pending review.', 409);
        const userId = requireId(card.user_id, 'customer id');
        const accountId = requireId(card.account_id, 'account id');
        const [user, account] = await Promise.all([tx.get('users', userId), tx.get('accounts', accountId)]);
        if (!user || boolFlag(user.disabled) || String(userId) !== String(account?.user_id)) throw workflowError('Card applicant or account ownership could not be confirmed.', 409);
        if (action === 'approve') {
          if (boolFlag(user.is_frozen)) throw workflowError('Frozen customers cannot have card applications approved.', 409);
          assertActiveAccount(account, 'approve a card application');
          if (!boolFlag(user.is_verified)) {
            const userKyc = await tx.list('kyc', [{ field: 'user_id', value: userId }], { limit: 1000 });
            if (userKyc.length >= 1000 || !userKyc.some((item) => item.status === 'approved')) throw workflowError('An approved KYC record is required before card approval.', 409);
          }
        }
        const status = action === 'approve' ? 'awaiting_issuer' : 'rejected';
        tx.update('cards', target, {
          status, reviewed_by: actor, reviewed_at: createdAt, updated_at: createdAt,
          ...(action === 'reject' ? { rejection_reason: reason } : { approved_by: actor, approved_at: createdAt, approval_reason: reason, fulfillment_status: 'manual_pending' })
        });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: action === 'approve' ? 'approve_card_for_manual_fulfillment' : 'reject_card', targetType: 'card', targetId: target, details: { user_id: userId, card_type: String(card.card_type || ''), previous: 'pending', next: status, reason, external_issuer: 'not_configured' }, ipAddress, createdAt }));
        tx.create('notifications', idFactory(), makeNotification({ userId, title: action === 'approve' ? 'Card application approved for fulfillment' : 'Card application rejected', message: action === 'approve' ? 'Your card application passed review and is awaiting manual issuer fulfillment. It cannot be activated until issuance is confirmed.' : `Your card application was rejected: ${reason}`, type: action === 'approve' ? 'info' : 'warning', createdAt, idFactory }));
        return { changed: true, status };
      });
      return result.result;
    },

    async changeCardStatus({ actorId, cardId, status: requestedStatus, reason: reasonInput, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(cardId, 'card id');
      const reason = requiredReason(reasonInput);
      const status = String(requestedStatus || '').trim().toLowerCase();
      if (!['active', 'frozen', 'blocked', 'lost_stolen'].includes(status)) throw workflowError('Choose active, frozen, blocked, or lost/stolen status.');
      const createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const card = await tx.get('cards', target);
        if (!card) throw workflowError('Card not found.', 404);
        const previous = String(card.status || '').toLowerCase();
        if (['pending', 'rejected'].includes(previous)) throw workflowError('Pending and rejected cards must use the application review action.', 409);
        if (['blocked', 'lost_stolen'].includes(previous) && status !== previous) throw workflowError('Blocked or lost cards cannot be reactivated or changed.', 409);
        if (previous !== status && status === 'active' && card.fulfillment_status !== 'issued') throw workflowError('Issuer fulfillment must be confirmed before card activation.', 409);
        const allowed = status === 'active' ? previous === 'frozen' : ['active', 'approved', 'awaiting_issuer', 'frozen'].includes(previous);
        if (!allowed && status !== previous) throw workflowError('This card status transition is not allowed.', 409);
        if (previous === status) return { changed: false, status };
        const userId = requireId(card.user_id, 'customer id');
        const user = await tx.get('users', userId);
        if (!user) throw workflowError('Cardholder profile is unavailable.', 409);
        tx.update('cards', target, { status, status_reason: reason, status_updated_by: actor, status_updated_at: createdAt, updated_at: createdAt });
        tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: `set_card_${status}`, targetType: 'card', targetId: target, details: { user_id: userId, previous, next: status, reason }, ipAddress, createdAt }));
        tx.create('notifications', idFactory(), makeNotification({ userId, title: 'Card status updated', message: `Your card status is now ${status.replace('_', '/')}.`, type: status === 'active' ? 'success' : 'warning', createdAt, idFactory }));
        return { changed: true, previous, status };
      });
      return result.result;
    },

    async reviewLoan({ actorId, loanId, action, body, ipAddress }) {
      const actor = requireActor(actorId), target = requireId(loanId, 'loan id');
      const decision = normalizeReview(body, action, { requireSettlement: action === 'approve' }), createdAt = clock();
      const result = await repo.runTransaction(async (tx) => {
        await requireCurrentAdmin(tx, actor);
        const loan = await tx.get('loans', target);
        if (!loan) throw workflowError('Loan application not found.', 404);
        if (loan.status !== 'pending') throw workflowError('Loan application is no longer pending review.', 409);
        const userId = requireId(loan.user_id, 'customer id');
        const user = await tx.get('users', userId);
        if (!user || boolFlag(user.disabled)) throw workflowError('Loan applicant is unavailable.', 409);
        if (action === 'reject') {
          tx.update('loans', target, { status: 'rejected', reviewed_by: actor, reviewed_at: createdAt, rejection_reason: decision.reason, updated_at: createdAt });
          tx.create('audit_logs', idFactory(), makeAudit({ actorId: actor, action: 'reject_loan', targetType: 'loan', targetId: target, details: { user_id: userId, previous: 'pending', next: 'rejected', reason: decision.reason }, ipAddress, createdAt }));
          tx.create('notifications', idFactory(), makeNotification({ userId, title: 'Loan application rejected', message: `Your loan application was rejected: ${decision.reason}`, type: 'warning', createdAt, idFactory }));
          return { changed: true, status: 'rejected' };
        }

        const product = LOAN_PRODUCTS[String(loan.loan_type || '')];
        if (!product) throw workflowError('This loan product is not configured for approval.', 409);
        const amountMinor = safeMinor(loan, 'loan_amount_minor', 'loan_amount');
        const maxSettlementMinor = configuredLimit('ADMIN_MAX_SETTLEMENT_MINOR', DEFAULT_MAX_SETTLEMENT_MINOR);
        if (amountMinor > maxSettlementMinor) throw workflowError(`Loan disbursement exceeds the current per-operation limit of ${maxSettlementMinor / 100}.`, 409);
        const maxProductMinor = toMinorUnits(String(product.max));
        const minProductMinor = toMinorUnits(String(product.min));
        const term = Number(loan.loan_term_months ?? loan.term_months);
        const rate = Number(loan.interest_rate);
        if (!Number.isSafeInteger(amountMinor) || amountMinor < minProductMinor || amountMinor > maxProductMinor) throw workflowError('The requested amount is outside the configured limit for this loan product.', 409);
        if (!Number.isInteger(term) || term < product.termMin || term > product.termMax) throw workflowError('The requested term is outside the configured limit for this loan product.', 409);
        if (!Number.isFinite(rate) || rate < product.rateMin || rate > product.rateMax) throw workflowError('The requested interest rate is outside the configured limit for this loan product.', 409);
        const remainingMinor = loan.remaining_balance_minor !== undefined
          ? safeMinor(loan, 'remaining_balance_minor', 'remaining_balance') : amountMinor;
        if (remainingMinor !== amountMinor) throw workflowError('Pending loan principal does not match its remaining balance.', 409);
        if (!boolFlag(user.is_verified)) {
          const userKyc = await tx.list('kyc', [{ field: 'user_id', value: userId }], { limit: 1000 });
          if (userKyc.length >= 1000 || !userKyc.some((item) => item.status === 'approved')) throw workflowError('An approved KYC record is required before loan disbursement.', 409);
        }
        const accountId = loan.account_id ? requireId(loan.account_id, 'account id') : decision.accountId;
        if (!accountId) throw workflowError('Select the customer account that will receive the disbursement.');
        if (decision.accountId && loan.account_id && decision.accountId !== String(loan.account_id)) throw workflowError('Disbursement account must match the account selected with the application.', 409);
        const account = await tx.get('accounts', accountId);
        if (!account || String(account.user_id) !== userId) throw workflowError('Disbursement account ownership could not be confirmed.', 409);
        assertActiveAccount(account, 'receive a loan disbursement');
        const { balanceMinor, availableMinor } = accountMoney(account);
        const newBalanceMinor = balanceMinor + amountMinor, newAvailableMinor = availableMinor + amountMinor;
        if (!Number.isSafeInteger(newBalanceMinor) || !Number.isSafeInteger(newAvailableMinor)) throw workflowError('Loan disbursement exceeds the supported account balance range.', 409);
        const transactionId = idFactory(), ledgerId = idFactory(), auditId = idFactory(), notificationId = idFactory();
        const currency = String(account.currency || 'AUD').toUpperCase();
        tx.update('accounts', accountId, { balance_minor: newBalanceMinor, available_balance_minor: newAvailableMinor, updated_at: createdAt });
        tx.update('loans', target, {
          status: 'disbursed', account_id: accountId, remaining_balance_minor: amountMinor,
          approved_by: actor, approved_at: createdAt, reviewed_by: actor, reviewed_at: createdAt,
          disbursed_at: createdAt, next_payment_date: monthAfter(createdAt), approval_reason: decision.reason,
          settlement_reference: decision.settlementReference, updated_at: createdAt
        });
        tx.create('transactions', transactionId, {
          user_id: userId, account_id: accountId, transaction_type: 'loan_disbursement', amount_minor: amountMinor,
          currency, description: `${String(loan.loan_type)} disbursement - Loan #${target}`, reference: decision.settlementReference,
          settlement_reference: decision.settlementReference,
          status: 'completed', approved_by: actor, approved_at: createdAt, created_at: createdAt
        });
        tx.create('ledger_entries', ledgerId, {
          user_id: userId, account_id: accountId, transaction_id: transactionId, reference_id: target,
          entry_type: 'loan_disbursement', amount_minor: amountMinor, balance_after_minor: newBalanceMinor,
          available_after_minor: newAvailableMinor, currency, status: 'completed', description: decision.reason, created_at: createdAt
        });
        tx.create('audit_logs', auditId, makeAudit({ actorId: actor, action: 'approve_loan_disbursement', targetType: 'loan', targetId: target, details: { user_id: userId, account_id: accountId, transaction_id: transactionId, amount_minor: amountMinor, currency, settlement_reference: decision.settlementReference, reason: decision.reason }, ipAddress, createdAt }));
        tx.create('notifications', notificationId, makeNotification({ userId, title: 'Loan approved and disbursed', message: `Your ${String(loan.loan_type)} was approved and credited to your account.`, type: 'success', createdAt, idFactory: () => notificationId }));
        return { changed: true, status: 'disbursed', transactionId, accountId };
      });
      return result.result;
    },

    async reviewBillPayment({ actorId, billPaymentId, action, body, ipAddress }) {
      return this.reviewTransaction({ actorId, billPaymentId, action, body, ipAddress });
    }
  };
}

module.exports = {
  createAdminWorkflows,
  normalizeUserProfile,
  normalizeAccountMetadata,
  normalizeCustomerIdentity,
  normalizeAccountCreation,
  normalizeBalanceAdjustment,
  normalizeReview,
  LOAN_PRODUCTS,
  DEFAULT_MAX_ADJUSTMENT_MINOR,
  DEFAULT_MAX_SETTLEMENT_MINOR
};
