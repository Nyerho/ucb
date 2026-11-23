'use strict';

const session = require('./firebase-session');

module.exports = async function sessionEncryptionReady(_req, res, next) {
  try {
    await session.assertSessionEncryptionReady();
    return next();
  } catch (error) {
    console.error('Session encryption preflight failed:', error && error.message ? error.message : 'unknown error');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).send('Secure session storage is temporarily unavailable.');
  }
};
