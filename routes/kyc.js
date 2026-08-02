const express = require('express');
const { db } = require('../database');
const {
  requireAuth,
  addNotification
} = require('../middleware/auth');

const router = express.Router();

const DOCUMENT_TYPES = [
  { type: 'Drivers Licence', name: "Australian Driver's Licence", requires_both: true },
  { type: 'Passport', name: 'Australian Passport', requires_both: false },
  { type: 'Proof of Age', name: 'Proof of Age Card', requires_both: true },
  { type: 'Medicare', name: 'Medicare Card', requires_both: true },
  { type: 'Birth Certificate', name: 'Australian Birth Certificate', requires_both: false },
  { type: 'Citizenship', name: 'Citizenship Certificate', requires_both: false }
];

router.get('/', requireAuth, (req, res) => {
  const kycRecords = db.prepare(`
    SELECT * FROM kyc
    WHERE user_id = ?
    ORDER BY submitted_at DESC
  `).all(req.session.userId);

  const latest = kycRecords[0] || null;

  res.render('kyc/index', {
    title: 'Identity Verification (KYC) - United Credit Bank',
    page: 'kyc',
    kycRecords,
    records: kycRecords,
    latest,
    documentTypes: DOCUMENT_TYPES
  });
});

router.get('/submit', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);

  res.render('kyc/submit', {
    title: 'Submit KYC - United Credit Bank',
    page: 'kyc',
    user,
    documentTypes: DOCUMENT_TYPES
  });
});

router.post('/submit', requireAuth, (req, res) => {
  const { document_type, document_number, id_expiry, document_front, document_back, document_selfie } = req.body;

  const existingPending = db.prepare('SELECT * FROM kyc WHERE user_id = ? AND status = ?').get(req.session.userId, 'pending');
  if (existingPending) {
    req.session.error = 'You already have a pending KYC submission. Please wait for review.';
    return res.redirect('/kyc');
  }

  const existingApproved = db.prepare('SELECT * FROM kyc WHERE user_id = ? AND status = ?').get(req.session.userId, 'approved');
  if (existingApproved) {
    req.session.error = 'Your identity is already verified.';
    return res.redirect('/kyc');
  }

  db.prepare(`
    INSERT INTO kyc (user_id, document_type, document_number, document_front, document_back, document_selfie, id_expiry, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    req.session.userId,
    document_type,
    document_number,
    document_front || 'uploads/kyc/default_front.jpg',
    document_back || 'uploads/kyc/default_back.jpg',
    document_selfie || 'uploads/kyc/default_selfie.jpg',
    id_expiry || null
  );

  addNotification(req.session.userId, 'KYC Submitted', 'Your identity verification has been submitted for review.', 'info');
  req.session.success = 'KYC documents submitted successfully! Our team will review within 24 hours.';
  res.redirect('/kyc');
});

router.get('/:id', requireAuth, (req, res) => {
  const kyc = db.prepare(`
    SELECT k.*, u.first_name, u.last_name, u.email
    FROM kyc k
    JOIN users u ON k.user_id = u.id
    WHERE k.id = ? AND k.user_id = ?
  `).get(req.params.id, req.session.userId);

  if (!kyc) {
    req.session.error = 'KYC record not found.';
    return res.redirect('/kyc');
  }

  res.render('kyc/detail', {
    title: 'KYC Details - United Credit Bank',
    page: 'kyc',
    kyc
  });
});

module.exports = router;
