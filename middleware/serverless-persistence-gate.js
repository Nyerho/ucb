// Keep customer/browser mutations disabled; explicitly allowlisted admin routes enforce
// verified admin identity, encrypted sessions, transaction validation, ledger writes, and audit.
const { getRuntimeEnv } = require('../lib/runtime-env');
const { getRequestPath, isSafeAdminMutation } = require('../lib/admin-safe-write-allowlist');

module.exports = function serverlessPersistenceGate(req, res, next) {
  const isServerless = Boolean(getRuntimeEnv('WORKER_RUNTIME') === '1' || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const requestPath = getRequestPath(req);
  const isAllowedAuthSubmission = req.method === 'POST'
    && (requestPath === '/auth/login' || requestPath === '/auth/forgot-password');
  if (process.env.NODE_ENV === 'production' && isServerless && isMutation && !isAllowedAuthSubmission && !isSafeAdminMutation(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
      error: 'Writes are temporarily disabled until Firebase security and production workflow gates are approved.'
    });
  }
  return next();
};
