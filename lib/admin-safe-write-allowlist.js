'use strict';

// Every route here must have an admin guard, session-encryption preflight,
// server-side validation, and an audited Firestore workflow.
const SAFE_ADMIN_POSTS = [
  /^\/admin\/users\/create$/,
  /^\/admin\/users\/[^/]+\/(?:update|freeze|unfreeze|disable|restore|password-reset|accounts)$/,
  /^\/admin\/accounts\/[^/]+\/(?:update|status|balance-adjustment)$/,
  /^\/admin\/cards\/[^/]+\/status$/,
  /^\/admin\/approvals\/(?:kyc|transfers|cards|loans|bills)\/[^/]+\/review$/
];

function getRequestPath(req) {
  const base = String(req && req.baseUrl || '').replace(/\/+$/, '');
  const path = String(req && req.path || '/');
  const joined = `${base}${path.startsWith('/') ? path : `/${path}`}`.replace(/\/{2,}/g, '/');
  return joined.replace(/\/+$/, '') || '/';
}

function isSafeAdminMutation(req) {
  if (!req || req.method !== 'POST') return false;
  const path = getRequestPath(req);
  return SAFE_ADMIN_POSTS.some((pattern) => pattern.test(path));
}

module.exports = { getRequestPath, isSafeAdminMutation, SAFE_ADMIN_POSTS };
