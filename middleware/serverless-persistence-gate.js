// Keep browser mutations disabled until Firebase rules and production workflows pass review.
const { getRuntimeEnv } = require('../lib/runtime-env');

module.exports = function serverlessPersistenceGate(req, res, next) {
  const isServerless = Boolean(getRuntimeEnv('WORKER_RUNTIME') === '1' || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (process.env.NODE_ENV === 'production' && isServerless && isMutation) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({
      error: 'Writes are temporarily disabled until Firebase security and production workflow gates are approved.'
    });
  }
  return next();
};
