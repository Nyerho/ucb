const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
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

const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'kyc');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const safeBase = path.basename(file.originalname || 'document', ext)
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'document';
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

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

router.post('/submit', requireAuth, upload.fields([
  { name: 'document_front', maxCount: 1 },
  { name: 'document_back', maxCount: 1 },
  { name: 'document_selfie', maxCount: 1 }
]), (req, res) => {
  const { document_type, document_number, id_expiry, document_front, document_back, document_selfie } = req.body;
  const selectedType = DOCUMENT_TYPES.find((doc) => doc.type === document_type);

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

  if (!selectedType) {
    req.session.error = 'Please choose a valid document type.';
    return res.redirect('/kyc/submit');
  }

  if (!String(document_number || '').trim()) {
    req.session.error = 'Document number is required.';
    return res.redirect('/kyc/submit');
  }

  const files = req.files || {};
  const frontFile = files.document_front && files.document_front[0];
  const backFile = files.document_back && files.document_back[0];
  const selfieFile = files.document_selfie && files.document_selfie[0];

  if (!frontFile) {
    req.session.error = 'Please upload the front of your document.';
    return res.redirect('/kyc/submit');
  }

  if (selectedType.requires_both && !backFile) {
    req.session.error = 'Please upload the back of your document.';
    return res.redirect('/kyc/submit');
  }

  db.prepare(`
    INSERT INTO kyc (user_id, document_type, document_number, document_front, document_back, document_selfie, id_expiry, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    req.session.userId,
    document_type,
    String(document_number || '').trim(),
    frontFile ? `uploads/kyc/${frontFile.filename}` : 'uploads/kyc/default_front.jpg',
    backFile ? `uploads/kyc/${backFile.filename}` : '',
    selfieFile ? `uploads/kyc/${selfieFile.filename}` : '',
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
