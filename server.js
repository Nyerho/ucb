'use strict';

const express = require('express');
const Layer = require('express/lib/router/layer');
const path = require('path');
const cookieParser = require('cookie-parser');
const ejs = require('ejs');
const moment = require('moment');
const { getRuntimeEnv } = require('./lib/runtime-env');
const IS_WORKER_RUNTIME = getRuntimeEnv('WORKER_RUNTIME') === '1';
const VIEWS_DIR = IS_WORKER_RUNTIME ? '/bundle' : path.join(__dirname, 'views');
const workerViewTemplates = IS_WORKER_RUNTIME ? require('./lib/worker-views.generated.cjs') : null;

function renderWorkerTemplate(viewName, locals) {
  const template = workerViewTemplates[viewName];
  if (typeof template !== 'function') throw new Error(`Unknown Worker view: ${viewName}`);
  const include = (requestedPath, includeLocals = {}) => {
    const request = String(requestedPath);
    if (path.posix.isAbsolute(request)) throw new Error('Absolute EJS includes are not supported in Workers.');
    let includedName = path.posix.normalize(path.posix.join(path.posix.dirname(viewName), request));
    if (includedName === '..' || includedName.startsWith('../')) throw new Error('EJS include path escapes the Worker views directory.');
    includedName = includedName.replace(/\.ejs$/, '');
    return renderWorkerTemplate(includedName, { ...locals, ...(includeLocals || {}) });
  };
  return template(locals || {}, ejs.escapeXML, include);
}

function workerViewEngine(filename, options, callback) {
  try {
    const relativePath = path.relative(VIEWS_DIR, filename).split(path.sep).join('/');
    const viewName = relativePath.replace(/\.ejs$/, '');
    callback(null, renderWorkerTemplate(viewName, options || {}));
  } catch (error) {
    callback(error);
  }
}

const originalLayerHandleRequest = Layer.prototype.handle_request;
Layer.prototype.handle_request = function patchedAsyncHandleRequest(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return originalLayerHandleRequest.call(this, req, res, next);
  try {
    const returned = fn(req, res, next);
    if (returned && typeof returned.then === 'function' && typeof returned.catch === 'function') returned.catch(next);
    return returned;
  } catch (error) {
    return next(error);
  }
};

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.engine('ejs', IS_WORKER_RUNTIME ? workerViewEngine : ejs.renderFile);
app.set('view engine', 'ejs');
app.set('views', VIEWS_DIR);
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production' && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});
app.use(async (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType === 'multipart/form-data' || (!contentType && req.body !== undefined)) return next();
  if (contentType !== 'application/json' && contentType !== 'application/x-www-form-urlencoded') return next();
  const limit = 64 * 1024;
  if (Number(req.headers['content-length'] || 0) > limit) return res.status(413).send('Request body is too large.');
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) return res.status(413).send('Request body is too large.');
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    req.body = contentType === 'application/json' ? (text ? JSON.parse(text) : {}) : Object.fromEntries(new URLSearchParams(text));
    return next();
  } catch (error) {
    if (error instanceof SyntaxError) return res.status(400).send('Invalid request body.');
    return next(error);
  }
});
app.use(cookieParser());
app.use(cookieParser());
app.use('/uploads/kyc', (_req, res) => res.status(404).end());
if (!IS_WORKER_RUNTIME) app.use(express.static(path.join(__dirname, 'public')));

app.use(require('./middleware/firebase-session'));
app.use(require('./middleware/firebase-authenticated-user'));

// Reject cross-site browser mutations. Production requests without Origin or Referer fail closed,
// except for non-browser clients explicitly marked as such by the Fetch metadata headers.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite === 'cross-site') return res.status(403).send('Cross-site request blocked.');
  const source = req.get('origin') || req.get('referer');
  if (!source) {
    if (process.env.NODE_ENV === 'production' && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
      return res.status(403).send('Request origin could not be verified.');
    }
    return next();
  }
  try {
    const sourceOrigin = new URL(source).origin;
    const requestHost = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
    const allowedOrigin = `${(req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0] === 'https') ? 'https' : 'http'}://${requestHost}`;
    if (sourceOrigin !== allowedOrigin) return res.status(403).send('Cross-site request blocked.');
  } catch (_) {
    return res.status(403).send('Request origin could not be verified.');
  }
  next();
});

app.use((req, res, next) => {
  res.locals.moment = moment;
  res.locals.currency = (amount, currency = 'AUD') => new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(amount || 0);
  res.locals.user = req.user || null;
  res.locals.error = req.session.error || null;
  res.locals.success = req.session.success || null;
  delete req.session.error;
  delete req.session.success;
  const originalRender = res.render.bind(res);
  res.render = function patchedRender(view, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (!opts || typeof opts !== 'object') opts = {};
    if (typeof opts.error === 'undefined') opts.error = res.locals.error;
    if (typeof opts.success === 'undefined') opts.success = res.locals.success;
    return originalRender(view, opts, cb);
  };
  next();
});

// Keep write paths unavailable until financial and identity-document controls have passed review.
app.use(require('./middleware/serverless-persistence-gate'));

app.use('/', require('./routes/index'));
app.use('/auth', require('./routes/auth'));
app.use('/user', require('./routes/user'));
app.use('/accounts', require('./routes/accounts'));
app.use('/transfers', require('./routes/transfers'));
app.use('/cards', require('./routes/cards'));
app.use('/loans', require('./routes/loans'));
app.use('/kyc', require('./routes/kyc'));
app.use('/billpay', require('./routes/billpay'));
app.use('/admin', require('./routes/admin'));
app.use('/api', require('./routes/api'));

app.use((req, res) => res.status(404).render('errors/404', { title: 'Page Not Found - United Credit Bank', page: '404' }));
app.use((err, req, res, next) => {
  console.error('Request failed:', err && err.message ? err.message : 'unknown error');
  if (res.headersSent) return next(err);
  return res.status(500).render('errors/500', {
    title: 'Server Error - United Credit Bank', page: '500',
    error: process.env.NODE_ENV === 'development' ? err.message : null
  });
});

if (require.main === module) app.listen(PORT, () => console.log(`United Credit Bank server listening on port ${PORT}`));
module.exports = app;
