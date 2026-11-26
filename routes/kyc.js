'use strict';

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { uploadObject, downloadObject, deleteObject } = require('../services/firebase-storage');
const { requireAuth, isAdminUser, addNotification } = require('../middleware/auth');
const { legacyProfileId } = require('../services/firebase-owner-id');
const { ownerIdsForRequest, listByOwnerIds, recordHasOwnerId } = require('../services/owner-records');

const router = express.Router();
router.use(require('../middleware/production-pii-gate'));
const repo = createFirestoreRepository();
const DOCUMENT_TYPES = [
  { type: 'Drivers Licence', name: "Australian Driver's Licence", requires_both: true },
  { type: 'Passport', name: 'Australian Passport', requires_both: false },
  { type: 'Proof of Age', name: 'Proof of Age Card', requires_both: true },
  { type: 'Medicare', name: 'Medicare Card', requires_both: true },
  { type: 'Birth Certificate', name: 'Australian Birth Certificate', requires_both: false },
  { type: 'Citizenship', name: 'Citizenship Certificate', requires_both: false }
];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 3 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    cb(allowed.has(file.mimetype) ? null : new Error('Unsupported document file type.'), allowed.has(file.mimetype));
  }
});
function uid(req) { return String(req.auth?.uid || req.auth?.sub || req.session?.userId || ''); }
function profileDocumentId(req) { const explicit = req.session?.profileId || req.user?.profileId || req.user?.id; return String(explicit || legacyProfileId(uid(req)) || uid(req)); }
function decorateRecord(record) {
  return { ...record, id: String(record.id), user_id: String(record.user_id), submitted_at: record.submitted_at || record.created_at || null };
}
function storageName(owner, recordId, kind, file) {
  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' })[file.mimetype];
  return `kyc/${owner}/${recordId}/${kind}-${crypto.randomUUID()}.${extension}`;
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const rows = await listByOwnerIds(repo, 'kyc', ownerIdsForRequest(req), [], { orderBy: { field: 'submitted_at', direction: 'DESCENDING' } });
    const kycRecords = rows.map(decorateRecord);
    res.render('kyc/index', { title: 'Identity Verification (KYC) - United Credit Bank', page: 'kyc', kycRecords, records: kycRecords, latest: kycRecords[0] || null, documentTypes: DOCUMENT_TYPES });
  } catch (error) { console.error('KYC listing failed:', error); res.sendStatus(503); }
});

router.get('/submit', requireAuth, async (req, res) => {
  try {
    const user = await repo.get('users', profileDocumentId(req));
    res.render('kyc/submit', { title: 'Submit KYC - United Credit Bank', page: 'kyc', user, documentTypes: DOCUMENT_TYPES });
  } catch (error) { console.error('KYC form profile read failed:', error); res.sendStatus(503); }
});

router.post('/submit', requireAuth, upload.fields([
  { name: 'document_front', maxCount: 1 }, { name: 'document_back', maxCount: 1 }, { name: 'document_selfie', maxCount: 1 }
]), async (req, res) => {
  const owner = uid(req);
  try {
    const { document_type, document_number, id_expiry } = req.body;
    const selectedType = DOCUMENT_TYPES.find((doc) => doc.type === document_type);
    const files = req.files || {};
    const front = files.document_front?.[0];
    const back = files.document_back?.[0];
    const selfie = files.document_selfie?.[0];
    if (!selectedType) { req.session.error = 'Please choose a valid document type.'; return res.redirect('/kyc/submit'); }
    if (!String(document_number || '').trim()) { req.session.error = 'Document number is required.'; return res.redirect('/kyc/submit'); }
    if (!front) { req.session.error = 'Please upload the front of your document.'; return res.redirect('/kyc/submit'); }
    if (selectedType.requires_both && !back) { req.session.error = 'Please upload the back of your document.'; return res.redirect('/kyc/submit'); }
    const existing = await listByOwnerIds(repo, 'kyc', ownerIdsForRequest(req));
    if (existing.some((record) => record.status === 'pending')) { req.session.error = 'You already have a pending KYC submission. Please wait for review.'; return res.redirect('/kyc'); }
    if (existing.some((record) => record.status === 'approved')) { req.session.error = 'Your identity is already verified.'; return res.redirect('/kyc'); }

    const id = crypto.randomUUID();
    const objects = [];
    try {
      const store = async (kind, file) => {
        if (!file) return '';
        const name = storageName(owner, id, kind, file);
        await uploadObject(name, file.buffer, file.mimetype);
        objects.push(name);
        return name;
      };
      const document_front = await store('front', front);
      const document_back = await store('back', back);
      const document_selfie = await store('selfie', selfie);
      const now = new Date().toISOString();
      await repo.create('kyc', {
        id, user_id: owner, document_type, document_number: String(document_number).trim(),
        document_front, document_back, document_selfie, id_expiry: id_expiry || null,
        status: 'pending', submitted_at: now, created_at: now
      }, id);
    } catch (error) {
      await Promise.allSettled(objects.map(deleteObject));
      throw error;
    }
    try { await addNotification(owner, 'KYC Submitted', 'Your identity verification has been submitted for review.', 'info'); } catch (error) { console.error('KYC notification failed:', error); }
    req.session.success = 'KYC documents submitted successfully! Our team will review within 24 hours.';
    return res.redirect('/kyc');
  } catch (error) { console.error('KYC submission failed:', error); return res.sendStatus(503); }
});

router.get('/:id/document/:kind', requireAuth, async (req, res) => {
  try {
    const fields = { front: 'document_front', back: 'document_back', selfie: 'document_selfie' };
    const field = fields[req.params.kind];
    if (!field || !req.params.id) return res.sendStatus(404);
    const record = await repo.get('kyc', String(req.params.id));
    if (!record) return res.sendStatus(404);
    const owner = uid(req);
    const isAdmin = isAdminUser(req.user);
    if (!recordHasOwnerId(record, ownerIdsForRequest(req)) && !isAdmin) return res.sendStatus(404);
    const objectName = String(record[field] || '');
    if (!objectName || !objectName.startsWith(`kyc/${String(record.user_id)}/`)) return res.sendStatus(404);
    const file = await downloadObject(objectName);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', 'attachment');
    return res.send(Buffer.from(file.bytes));
  } catch (error) { console.error('KYC document retrieval failed:', error); if (!res.headersSent) return res.sendStatus(503); }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const record = await repo.get('kyc', String(req.params.id));
    if (!recordHasOwnerId(record, ownerIdsForRequest(req))) { req.session.error = 'KYC record not found.'; return res.redirect('/kyc'); }
    const user = await repo.get('users', profileDocumentId(req));
    const kyc = decorateRecord({ ...record, first_name: user?.first_name || '', last_name: user?.last_name || '', email: user?.email || '' });
    return res.render('kyc/detail', { title: 'KYC Details - United Credit Bank', page: 'kyc', kyc });
  } catch (error) { console.error('KYC detail read failed:', error); return res.sendStatus(503); }
});

module.exports = router;
