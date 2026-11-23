const express = require('express');
const { createFirestoreRepository } = require('../services/firestore-rest');

const router = express.Router();
const repo = createFirestoreRepository();

router.get('/', async (req, res) => {
  if (req.session.userId) {
    if (req.session.user && req.session.user.is_admin === 1) {
      return res.redirect('/admin/dashboard');
    }
    return res.redirect('/user/dashboard');
  }

  try {
    const [users, accounts] = await Promise.all([
      repo.list('users', [{ field: 'is_admin', op: 'EQUAL', value: 0 }]),
      repo.list('accounts')
    ]);
    const stats = {
      customers: users.length,
      accounts: accounts.length,
      branches: 58,
      years: 42
    };

    return res.render('index', {
      title: 'United Credit Bank - Australian Banking Excellence',
      page: 'home',
      stats
    });
  } catch (error) {
    return res.status(503).send('Banking service is temporarily unavailable. Please try again later.');
  }
});

router.get('/about', (req, res) => {
  res.render('about', {
    title: 'About Us - United Credit Bank',
    page: 'about'
  });
});

router.get('/contact', (req, res) => {
  res.render('contact', {
    title: 'Contact Us - United Credit Bank',
    page: 'contact'
  });
});

router.get('/services', (req, res) => {
  res.render('services', {
    title: 'Our Services - United Credit Bank',
    page: 'services'
  });
});

router.post('/contact', (req, res) => {
  req.session.success = 'Thank you for your message! Our team will contact you within 24 hours.';
  res.redirect('/contact');
});

module.exports = router;
