'use strict';

const { ownerLookupIds, hasVerifiedFirebaseUidBinding } = require('./firebase-owner-id');

function ownerIdsForIdentity(firebaseUid, profileId, verifiedProfile) {
  return ownerLookupIds(firebaseUid, profileId, verifiedProfile);
}

function ownerIdsForRequest(req) {
  const uid = String(req?.auth?.uid || req?.session?.userId || req?.user?.uid || '').trim();
  const profileId = String(req?.session?.profileId || req?.user?.profileId || req?.user?.id || uid).trim();
  const profile = req?.user;
  const verifiedProfile = String(profile?.uid || profile?.firebaseUid || '').trim() === uid
    && hasVerifiedFirebaseUidBinding(profile, uid) ? profile : null;
  return ownerIdsForIdentity(uid, profileId, verifiedProfile);
}

function compareByOptions(left, right, orderBy) {
  const order = Array.isArray(orderBy) ? orderBy : [orderBy];
  for (const item of order) {
    if (!item || !item.field) continue;
    const a = left[item.field], b = right[item.field];
    if (a === b) continue;
    if (a === undefined || a === null) return 1;
    if (b === undefined || b === null) return -1;
    const comparison = typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b));
    if (comparison) return item.direction === 'DESCENDING' || item.direction === 'desc' ? -comparison : comparison;
  }
  return String(left.id || '').localeCompare(String(right.id || ''));
}

async function listByOwnerIds(repository, collection, ownerIds, filters = [], options = {}) {
  const owners = [...new Set((ownerIds || []).map(value => String(value || '').trim()).filter(Boolean))];
  if (!owners.length) return [];
  const resultSets = await Promise.all(owners.map(ownerId => repository.list(
    collection,
    [{ field: 'user_id', value: ownerId }, ...filters],
    options
  )));
  const records = new Map();
  for (const record of resultSets.flat()) {
    const key = String(record && record.id || JSON.stringify(record));
    if (!records.has(key)) records.set(key, record);
  }
  const merged = [...records.values()];
  if (options.orderBy) merged.sort((a, b) => compareByOptions(a, b, options.orderBy));
  return options.limit === undefined ? merged : merged.slice(0, options.limit);
}

function recordHasOwnerId(record, ownerIds) {
  const owner = String(record && record.user_id || '');
  return Boolean(owner && (ownerIds || []).some(id => String(id) === owner));
}

async function getOwnedAccount(repository, accountId, ownerIds) {
  if (!accountId) return null;
  const account = await repository.get('accounts', String(accountId));
  return recordHasOwnerId(account, ownerIds) ? account : null;
}

module.exports = { ownerIdsForIdentity, ownerIdsForRequest, listByOwnerIds, recordHasOwnerId, getOwnedAccount };
