// KYC records are currently held in SQLite and uploads have no durable private object store.
module.exports = function productionPiiGate(req, res, next) {
  if (process.env.NODE_ENV === 'production' && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send('Identity document submission is unavailable until private durable storage is configured.');
  }
  return next();
};
