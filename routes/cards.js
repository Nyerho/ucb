'use strict';

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { createFirestoreRepository } = require('../services/firestore-rest');
const { toMinorUnits, fromMinorUnits } = require('../services/money');
const { requireAuth, requireVerified, getAccountStatusMessage } = require('../middleware/auth');
const { ownerIdsForRequest, listByOwnerIds, recordHasOwnerId } = require('../services/owner-records');

const router = express.Router();
const repo = createFirestoreRepository();
router.use(require('../middleware/production-financial-gate'));

const CARD_TYPES = [
  { type: 'Debit Card', name: 'Everyday Debit Card', annual_fee: 0, daily_limit: 2000, features: ['Tap & Pay', 'Contactless up to $200', 'EFTPOS & ATM access', 'Free monthly statements', 'Online shopping security'], image: '💳' },
  { type: 'Gold Debit', name: 'Gold Debit Card', annual_fee: 49, daily_limit: 5000, features: ['All Standard features', 'Higher daily limits', 'Travel insurance', 'Lounge access (2/year)', 'Reward points: 1/$1'], image: '🥇' },
  { type: 'Platinum Debit', name: 'Platinum Debit Card', annual_fee: 149, daily_limit: 10000, features: ['All Gold features', 'Unlimited lounge access', 'Comprehensive insurance', 'Concierge service', 'Reward points: 2/$1'], image: '💎' },
  { type: 'Credit Card', name: 'Low Rate Credit Card', annual_fee: 0, daily_limit: 0, credit_limit: 15000, interest_rate: 12.99, features: ['12.99% p.a. purchase rate', '55 interest-free days', 'Up to $15,000 limit', 'Fraud protection', 'Mobile wallet support'], image: '💳' },
  { type: 'Gold Credit', name: 'Gold Rewards Credit Card', annual_fee: 99, daily_limit: 0, credit_limit: 30000, interest_rate: 15.99, features: ['15.99% p.a. purchase rate', 'Reward points: 1.5/$1', 'Domestic travel insurance', 'Extended warranty', '2 lounge passes'], image: '🥇' },
  { type: 'Platinum Credit', name: 'Platinum Premium Credit Card', annual_fee: 299, daily_limit: 0, credit_limit: 75000, interest_rate: 18.99, features: ['18.99% p.a. purchase rate', 'Reward points: 3/$1', 'International insurance', 'Unlimited lounge', '24/7 concierge'], image: '💎' }
];

function buildCardTypeViewModel(cardType) {
  const isCredit = cardType.type.includes('Credit');
  return { ...cardType,
    desc: isCredit ? `Premium ${cardType.name.toLowerCase()} with flexible credit access and Australian support.` : `${cardType.name} for everyday banking, contactless purchases, and ATM access across Australia.`,
    fee: `$${cardType.annual_fee} / year`, fee_raw: cardType.annual_fee || 0,
    interest: isCredit ? `${cardType.interest_rate.toFixed(2)}% p.a.` : 'No purchase interest',
    limit: isCredit ? `$${(cardType.credit_limit || 0).toLocaleString()} credit` : `$${(cardType.daily_limit || 0).toLocaleString()} daily`,
    limit_raw: isCredit ? (cardType.credit_limit || 0) : (cardType.daily_limit || 0)
  };
}

const uid = (req) => String(req.session.userId);
const ownerIds = (req) => ownerIdsForRequest(req);
async function userProfile(req) { return req.user || await repo.get('users', String(req.session.profileId || req.user?.profileId || req.user?.id || uid(req))); }
async function notify(userId, title, message, type) {
  await repo.create('notifications', { user_id: String(userId), title, message, type, read: false, created_at: new Date().toISOString() }, crypto.randomUUID());
}
function cardNumber() { return `4${crypto.randomInt(0, 1e15).toString().padStart(15, '0')}`; }
function cardView(card, account) {
  return { ...card, account_number: account?.account_number || '', account_name: account?.account_name || '', applied_at: card.requested_at, issued_at: card.approved_at,
    daily_limit: Number.isSafeInteger(card.daily_limit_minor) ? fromMinorUnits(card.daily_limit_minor) : 0,
    credit_limit: Number.isSafeInteger(card.credit_limit_minor) ? fromMinorUnits(card.credit_limit_minor) : 0,
    available_credit: Number.isSafeInteger(card.available_credit_minor) ? fromMinorUnits(card.available_credit_minor) : 0 };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const owners = ownerIds(req);
    const [storedCards, user] = await Promise.all([listByOwnerIds(repo, 'cards', owners, [], { orderBy: { field: 'requested_at', direction: 'desc' } }), userProfile(req)]);
    const cards = await Promise.all(storedCards.map(async (card) => {
      const linked = await repo.get('accounts', String(card.account_id));
      return cardView(card, recordHasOwnerId(linked, owners) ? linked : null);
    }));
    res.render('cards/index', { title: 'My Cards - United Credit Bank', page: 'cards', cards, cardTypes: CARD_TYPES.map(buildCardTypeViewModel), user });
  } catch (error) { next(error); }
});

router.get('/apply/new', requireAuth, (req, res) => {
  const query = req.query.type ? `?type=${encodeURIComponent(req.query.type)}` : '';
  res.redirect(`/cards/apply${query}`);
});

router.get('/apply', requireAuth, requireVerified, async (req, res, next) => {
  try {
    const owners = ownerIds(req);
    const [accounts, approvedKyc, user] = await Promise.all([
      listByOwnerIds(repo, 'accounts', owners),
      listByOwnerIds(repo, 'kyc', owners, [{ field: 'status', value: 'approved' }], { limit: 1 }), userProfile(req)
    ]);
    const eligibleAccounts = accounts.filter((account) => !getAccountStatusMessage(account, 'apply for a card'));
    const cardTypes = CARD_TYPES.map(buildCardTypeViewModel);
    const selectedCardType = cardTypes.find(card => card.type === req.query.type)?.type || cardTypes[0]?.type || null;
    res.render('cards/apply', { title: 'Apply for Card - United Credit Bank', page: 'cards', accounts: eligibleAccounts, cardTypes, selectedCardType, isVerified: approvedKyc.length > 0, user });
  } catch (error) { next(error); }
});

router.post('/apply', requireAuth, requireVerified, async (req, res, next) => {
  try {
    const { card_type, account_id, delivery_address, pin, cardholder_name, credit_limit } = req.body;
    const type = CARD_TYPES.find((item) => item.type === card_type);
    if (!type) { req.session.error = 'Invalid card type.'; return res.redirect('/cards/apply'); }
    const owners = ownerIds(req);
    const [account, user] = await Promise.all([repo.get('accounts', String(account_id)), userProfile(req)]);
    if (!recordHasOwnerId(account, owners)) { req.session.error = 'Invalid account selected.'; return res.redirect('/cards/apply'); }
    const restriction = getAccountStatusMessage(account, 'apply for a card');
    if (restriction) { req.session.error = restriction; return res.redirect('/cards/apply'); }
    if (credit_limit && !type.type.includes('Credit')) { req.session.error = 'Invalid credit limit.'; return res.redirect('/cards/apply'); }
    const requestedCredit = credit_limit ? toMinorUnits(credit_limit) : toMinorUnits(type.credit_limit || 0);
    if (requestedCredit < 0) { req.session.error = 'Invalid credit limit.'; return res.redirect('/cards/apply'); }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const doc = {
      user_id: uid(req), account_id: String(account_id), card_type: type.type, card_number: cardNumber(),
      cardholder_name: cardholder_name || `${user?.first_name || ''} ${user?.last_name || ''}`.trim(),
      expiry_date: `12/${new Date().getFullYear() + 4}`, cvv: String(crypto.randomInt(0, 1000)).padStart(3, '0'),
      pin_hash: pin ? bcrypt.hashSync(String(pin), 8) : null,
      daily_limit_minor: toMinorUnits(type.daily_limit || 2000), credit_limit_minor: type.type.includes('Credit') ? requestedCredit : 0,
      available_credit_minor: type.type.includes('Credit') ? requestedCredit : 0, status: 'pending',
      delivery_address: delivery_address || 'On hold - Collect at branch', requested_at: now, created_at: now
    };
    await repo.create('cards', doc, id);
    await notify(uid(req), 'Card Application Submitted', `Your ${type.name} application is being reviewed.`, 'info');
    req.session.success = `Your ${type.name} application has been submitted successfully! You will be notified once approved.`;
    res.redirect('/cards');
  } catch (error) { if (error instanceof TypeError || error instanceof RangeError) { req.session.error = error.message; return res.redirect('/cards/apply'); } next(error); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const [card, user] = await Promise.all([repo.get('cards', String(req.params.id)), userProfile(req)]);
    const owners = ownerIds(req);
    if (!recordHasOwnerId(card, owners)) { req.session.error = 'Card not found.'; return res.redirect('/cards'); }
    const linked = await repo.get('accounts', String(card.account_id));
    const account = recordHasOwnerId(linked, owners) ? linked : null;
    res.render('cards/detail', { title: `${card.card_type} - United Credit Bank`, page: 'cards', card: cardView(card, account), user });
  } catch (error) { next(error); }
});

async function mutateCard(repository, req, mutator) {
  const id = String(req.params.id), owners = ownerIds(req);
  const result = await repository.runTransaction(async (tx) => {
    const card = await tx.get('cards', id);
    if (!recordHasOwnerId(card, owners)) return null;
    const changes = await mutator(card);
    if (!changes) return card;
    tx.update('cards', id, { ...changes.fields, updated_at: new Date().toISOString() });
    if (changes.notification) tx.create('notifications', crypto.randomUUID(), { user_id: uid(req), ...changes.notification, read: false, created_at: new Date().toISOString() });
    return { ...card, ...changes.fields };
  });
  return result?.result || null;
}
router.post('/:id/activate', requireAuth, async (req, res, next) => {
  try { const card = await mutateCard(repo, req, (item) => item.status === 'approved' ? { fields: { status: 'active' }, notification: { title: 'Card Activated', message: `Your ${item.card_type} is now active.`, type: 'success' } } : null);
    if (!card || card.status !== 'active') { req.session.error = 'Cannot activate this card.'; return res.redirect('/cards'); }
    req.session.success = 'Card activated successfully!'; res.redirect(`/cards/${req.params.id}`);
  } catch (error) { next(error); }
});
router.post('/:id/freeze', requireAuth, async (req, res, next) => {
  try { const card = await mutateCard(repo, req, (item) => { const status = item.status === 'frozen' ? 'active' : 'frozen'; return { fields: { status }, notification: { title: `Card ${status === 'frozen' ? 'Frozen' : 'Unfrozen'}`, message: `Your ${item.card_type} status has been updated.`, type: 'info' } }; });
    if (!card) { req.session.error = 'Card not found.'; return res.redirect('/cards'); }
    req.session.success = `Card ${card.status === 'frozen' ? 'frozen' : 'unfrozen'} successfully.`; res.redirect(`/cards/${req.params.id}`);
  } catch (error) { next(error); }
});
router.get('/:id/freeze', (_req, res) => res.sendStatus(405));
router.get('/:id/unfreeze', (_req, res) => res.sendStatus(405));
router.post('/:id/report-lost', requireAuth, async (req, res, next) => {
  try { const card = await mutateCard(repo, req, (item) => ({ fields: { status: 'lost_stolen' }, notification: { title: 'Card Reported Lost/Stolen', message: `Your ${item.card_type} has been blocked. A replacement will be sent.`, type: 'warning' } }));
    if (!card) { req.session.error = 'Card not found.'; return res.redirect('/cards'); }
    req.session.success = 'Card reported lost/stolen. A replacement card will be issued.'; res.redirect('/cards');
  } catch (error) { next(error); }
});
router.get('/:id/report', (_req, res) => res.sendStatus(405));
router.post('/:id/set-pin', requireAuth, async (req, res, next) => {
  try {
    const { pin } = req.body;
    if (!pin || String(pin).length !== 4 || !/^\d+$/.test(String(pin))) { req.session.error = 'PIN must be exactly 4 digits.'; return res.redirect(`/cards/${req.params.id}`); }
    const card = await mutateCard(repo, req, (item) => item.status === 'active' ? { fields: { pin_hash: bcrypt.hashSync(String(pin), 8) } } : null);
    if (!card || card.status !== 'active') { req.session.error = 'Cannot set PIN for this card.'; return res.redirect('/cards'); }
    req.session.success = 'PIN updated successfully!'; res.redirect(`/cards/${req.params.id}`);
  } catch (error) { next(error); }
});
router.post('/:id/replace', requireAuth, async (req, res, next) => {
  try { const card = await mutateCard(repo, req, () => ({ fields: { status: 'replacement_issued' } }));
    if (!card) { req.session.error = 'Card not found.'; return res.redirect('/cards'); }
    req.session.success = 'Replacement card requested. It will be mailed within 5-7 business days.'; res.redirect('/cards');
  } catch (error) { next(error); }
});
router.get('/:id/replace', (_req, res) => res.sendStatus(405));
module.exports = router;
module.exports.mutateCard = mutateCard;
