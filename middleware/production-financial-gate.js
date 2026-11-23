// This application currently has no regulated settlement/card-issuing integration.
// Keep simulated financial mutations unavailable in production until a real adapter,
// durable ledger, idempotency, and reconciliation controls are implemented and tested.
module.exports = function productionFinancialGate(req, res, next) {
  if (process.env.NODE_ENV === 'production' && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send('Financial operations are unavailable until the production settlement service is configured.');
  }
  return next();
};
