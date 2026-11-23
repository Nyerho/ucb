// External settlement and card-issuing integrations are not configured.
// Allow only the explicitly audited admin workflows; all customer/provider mutations
// and unlisted admin operations remain blocked until their integrations are reviewed.
const { isSafeAdminMutation } = require('../lib/admin-safe-write-allowlist');

module.exports = function productionFinancialGate(req, res, next) {
  if (process.env.NODE_ENV === 'production' && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !isSafeAdminMutation(req)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send('Financial operations are unavailable until the production settlement service is configured.');
  }
  return next();
};
