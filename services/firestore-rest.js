'use strict';

const { getRuntimeEnv } = require('../lib/runtime-env');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FIRESTORE_SCOPE = 'https://www.googleapis.com/auth/datastore';
const TOKEN_MARGIN_SECONDS = 60;
const serviceTokenCache = new Map();
let joseModulePromise;

function envValue(name) {
  const value = getRuntimeEnv(name);
  if (value) return String(value);
  const jsonField = {
    FIREBASE_PROJECT_ID: 'project_id',
    FIREBASE_CLIENT_EMAIL: 'client_email',
    FIREBASE_PRIVATE_KEY: 'private_key'
  }[name];
  if (jsonField) {
    const account = parseServiceAccountJson(getRuntimeEnv('FIREBASE_SERVICE_ACCOUNT_JSON'));
    if (account && account[jsonField]) return String(account[jsonField]);
  }
  throw new Error(`Missing required runtime binding: ${name}`);
}

function parseServiceAccountJson(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let account;
  try {
    account = typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch (_) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.');
  }
  if (!account || typeof account !== 'object' || Array.isArray(account)) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON must contain a JSON object.');
  }
  return account;
}

async function jose() {
  joseModulePromise ||= import('jose');
  return joseModulePromise;
}

function baseUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Firestore does not accept non-finite numbers.');
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === 'bigint') return { integerValue: value.toString() };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') {
    const fields = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) fields[key] = toFirestoreValue(item);
    }
    return { mapValue: { fields } };
  }
  throw new TypeError(`Unsupported Firestore value type: ${typeof value}`);
}

function fromFirestoreValue(value) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) {
    const n = Number(value.integerValue);
    return Number.isSafeInteger(n) ? n : value.integerValue;
  }
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return undefined;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, fromFirestoreValue(value)]));
}

function validateSegment(value, label) {
  const segment = String(value || '');
  if (!segment || segment.includes('/') || segment === '.' || segment === '..') {
    throw new TypeError(`Invalid Firestore ${label}.`);
  }
  return segment;
}

function documentPath(collection, id) {
  return `${validateSegment(collection, 'collection')}/${encodeURIComponent(validateSegment(id, 'document id'))}`;
}

function documentResourceName(collection, id) {
  return `projects/${encodeURIComponent(envValue('FIREBASE_PROJECT_ID'))}/databases/(default)/documents/${documentPath(collection, id)}`;
}

async function getServiceAccessToken(scope = FIRESTORE_SCOPE) {
  const now = Math.floor(Date.now() / 1000);
  const cached = serviceTokenCache.get(scope);
  if (cached && cached.expiresAt > now + TOKEN_MARGIN_SECONDS) return cached.accessToken;

  const projectId = envValue('FIREBASE_PROJECT_ID');
  const clientEmail = envValue('FIREBASE_CLIENT_EMAIL');
  const privateKey = envValue('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');
  const { importPKCS8, SignJWT } = await jose();
  const key = await importPKCS8(privateKey, 'RS256');
  const assertion = await new SignJWT({ scope })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience(GOOGLE_TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    serviceTokenCache.delete(scope);
    throw new Error('Firebase service authorization failed. Check Worker secrets and service-account IAM.');
  }
  serviceTokenCache.set(scope, {
    accessToken: payload.access_token,
    expiresAt: now + Number(payload.expires_in || 3600)
  });
  return payload.access_token;
}

async function firestoreRequest(path, { method = 'GET', body, query } = {}) {
  const projectId = envValue('FIREBASE_PROJECT_ID');
  const url = new URL(`${baseUrl(projectId)}${path ? `/${path}` : ''}`);
  if (query) {
    const entries = Array.isArray(query) ? query : Object.entries(query);
    for (const [key, value] of entries) {
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else if (value !== undefined && value !== null) url.searchParams.append(key, String(value));
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${await getServiceAccessToken()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const code = result && result.error && result.error.status;
    const detail = result && result.error && typeof result.error.message === 'string'
      ? result.error.message.replace(/\s+/g, ' ').trim().slice(0, 400)
      : '';
    const error = new Error(`Firestore request failed (${code || response.status})${detail ? `: ${detail}` : ''}.`);
    error.status = response.status;
    error.code = code || 'FIRESTORE_ERROR';
    throw error;
  }
  return result;
}

function decodeDocument(document) {
  if (!document) return null;
  const id = document.name.split('/').pop();
  return { ...decodeFields(document.fields || {}), id: decodeURIComponent(id) };
}

function encodeFields(data) {
  const fields = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined) fields[key] = toFirestoreValue(value);
  }
  return fields;
}

function buildStructuredQuery(collection, filters = [], { orderBy, limit } = {}) {
  const clauses = filters.map(({ field, op = 'EQUAL', value }) => ({
    fieldFilter: {
      field: { fieldPath: validateFieldPath(field) },
      op,
      value: toFirestoreValue(value)
    }
  }));
  const structuredQuery = { from: [{ collectionId: validateSegment(collection, 'collection') }] };
  if (clauses.length === 1) structuredQuery.where = clauses[0];
  if (clauses.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: clauses } };
  if (orderBy) {
    const orderList = Array.isArray(orderBy) ? orderBy : [orderBy];
    structuredQuery.orderBy = orderList.map((item) => ({
      field: { fieldPath: validateFieldPath(item.field) },
      direction: item.direction === 'DESCENDING' || item.direction === 'desc' ? 'DESCENDING' : 'ASCENDING'
    }));
  }
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('Firestore query limit must be from 1 to 1000.');
    structuredQuery.limit = limit;
  }
  return structuredQuery;
}

function validateFieldPath(field) {
  const value = String(field || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new TypeError('Invalid Firestore field path.');
  return value;
}

async function runQuery(collection, filters = [], options = {}, transaction) {
  const body = { structuredQuery: buildStructuredQuery(collection, filters, options) };
  if (transaction) body.transaction = transaction;
  const result = await firestoreRequest(':runQuery', { method: 'POST', body });
  return (result || []).filter((row) => row.document).map((row) => decodeDocument(row.document));
}

function createFirestoreRepository() {
  return {
    async get(collection, id) {
      try {
        return decodeDocument(await firestoreRequest(documentPath(collection, id)));
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },

    async list(collection, filters = [], options = {}) {
      return runQuery(collection, filters, options);
    },

    async create(collection, data, id = crypto.randomUUID()) {
      const path = `${validateSegment(collection, 'collection')}?documentId=${encodeURIComponent(validateSegment(id, 'document id'))}`;
      const created = await firestoreRequest(path, {
        method: 'POST', body: { fields: encodeFields(data) }
      });
      return decodeDocument(created);
    },

    async set(collection, id, data) {
      const updated = await firestoreRequest(documentPath(collection, id), {
        method: 'PATCH', body: { fields: encodeFields(data) }
      });
      return decodeDocument(updated);
    },

    async update(collection, id, data) {
      const fields = encodeFields(data);
      const query = Object.keys(fields).map((field) => ['updateMask.fieldPaths', field]);
      query.push(['currentDocument.exists', 'true']);
      const updated = await firestoreRequest(documentPath(collection, id), {
        method: 'PATCH', body: { fields }, query
      });
      return decodeDocument(updated);
    },

    async delete(collection, id) {
      await firestoreRequest(documentPath(collection, id), { method: 'DELETE' });
      return true;
    },

    async runTransaction(callback) {
      const begun = await firestoreRequest(':beginTransaction', {
        method: 'POST', body: { options: { readWrite: {} } }
      });
      const transaction = begun.transaction;
      const writes = [];
      const api = {
        async get(collection, id) {
          try {
            const doc = await firestoreRequest(documentPath(collection, id), {
              query: { transaction }
            });
            return decodeDocument(doc);
          } catch (error) {
            if (error.status === 404) return null;
            throw error;
          }
        },
        async list(collection, filters = [], options = {}) {
          return runQuery(collection, filters, options, transaction);
        },
        set(collection, id, data) {
          writes.push({ update: { name: documentResourceName(collection, id), fields: encodeFields(data) } });
        },
        create(collection, id, data) {
          writes.push({ update: { name: documentResourceName(collection, id), fields: encodeFields(data) }, currentDocument: { exists: false } });
        },
        update(collection, id, data) {
          const fields = encodeFields(data);
          writes.push({
            update: { name: documentResourceName(collection, id), fields },
            updateMask: { fieldPaths: Object.keys(fields) },
            currentDocument: { exists: true }
          });
        },
        delete(collection, id) {
          writes.push({ delete: documentResourceName(collection, id), currentDocument: { exists: true } });
        }
      };
      try {
        const result = await callback(api);
        const committed = await firestoreRequest(':commit', {
          method: 'POST', body: { writes, transaction }
        });
        return { result, commitTime: committed.commitTime };
      } catch (error) {
        try {
          await firestoreRequest(':rollback', { method: 'POST', body: { transaction } });
        } catch (_) { /* Preserve the original transaction failure. */ }
        throw error;
      }
    }
  };
}

function resetServiceTokenCacheForTests() {
  serviceTokenCache.clear();
}

module.exports = {
  createFirestoreRepository,
  getServiceAccessToken,
  toFirestoreValue,
  fromFirestoreValue,
  decodeFields,
  buildStructuredQuery,
  resetServiceTokenCacheForTests,
  parseServiceAccountJson
};
