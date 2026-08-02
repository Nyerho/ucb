require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const cookieParser = require('cookie-parser');
const moment = require('moment');

const { db } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const firebaseWebConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyDGSYkZdTDDj_ucCKjkiC-8WejvdnrVfSQ',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'unitedcb-4845b.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'unitedcb-4845b',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'unitedcb-4845b.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '54110165279',
  appId: process.env.FIREBASE_APP_ID || '1:54110165279:web:04ddda35bfc2624f87b82a',
  measurementId: process.env.FIREBASE_MEASUREMENT_ID || 'G-HWYB1Q883J'
};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'united-credit-bank-super-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production'
  }
};

if (!isServerless) {
  const sessionPath = path.join(__dirname, '.sessions');
  fs.mkdirSync(sessionPath, { recursive: true });
  sessionConfig.store = new FileStore({
    path: sessionPath,
    retries: 1
  });
}

app.use(session(sessionConfig));

app.use((req, res, next) => {
  res.locals.moment = moment;
  res.locals.currency = (amount, currency = 'AUD') => {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: currency
    }).format(amount || 0);
  };
  res.locals.user = req.session.user || null;
  res.locals.error = req.session.error || null;
  res.locals.success = req.session.success || null;
  res.locals.firebaseWebConfig = firebaseWebConfig;
  delete req.session.error;
  delete req.session.success;
  next();
});

app.use((req, res, next) => {
  if (req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
      req.session.user = {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        is_admin: user.is_admin,
        is_verified: user.is_verified,
        is_frozen: user.is_frozen
      };
    }
  }
  next();
});

const indexRoutes = require('./routes/index');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const accountRoutes = require('./routes/accounts');
const transferRoutes = require('./routes/transfers');
const cardRoutes = require('./routes/cards');
const loanRoutes = require('./routes/loans');
const kycRoutes = require('./routes/kyc');
const billPayRoutes = require('./routes/billpay');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');

app.use('/', indexRoutes);
app.use('/auth', authRoutes);
app.use('/user', userRoutes);
app.use('/accounts', accountRoutes);
app.use('/transfers', transferRoutes);
app.use('/cards', cardRoutes);
app.use('/loans', loanRoutes);
app.use('/kyc', kycRoutes);
app.use('/billpay', billPayRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);

app.use((req, res) => {
  res.status(404).render('errors/404', {
    title: 'Page Not Found - United Credit Bank',
    page: '404'
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).render('errors/500', {
    title: 'Server Error - United Credit Bank',
    page: '500',
    error: process.env.NODE_ENV === 'development' ? err.message : null
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`United Credit Bank server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
