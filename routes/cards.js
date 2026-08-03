const express = require('express');
const { db, generateCardNumber, generateCVV } = require('../database');
const {
  requireAuth,
  requireVerified,
  getUserAccounts,
  getAccountStatusMessage,
  addNotification
} = require('../middleware/auth');

const router = express.Router();

const CARD_TYPES = [
  {
    type: 'Debit Card',
    name: 'Everyday Debit Card',
    annual_fee: 0,
    daily_limit: 2000,
    features: ['Tap & Pay', 'Contactless up to $200', 'EFTPOS & ATM access', 'Free monthly statements', 'Online shopping security'],
    image: '💳'
  },
  {
    type: 'Gold Debit',
    name: 'Gold Debit Card',
    annual_fee: 49,
    daily_limit: 5000,
    features: ['All Standard features', 'Higher daily limits', 'Travel insurance', 'Lounge access (2/year)', 'Reward points: 1/$1'],
    image: '🥇'
  },
  {
    type: 'Platinum Debit',
    name: 'Platinum Debit Card',
    annual_fee: 149,
    daily_limit: 10000,
    features: ['All Gold features', 'Unlimited lounge access', 'Comprehensive insurance', 'Concierge service', 'Reward points: 2/$1'],
    image: '💎'
  },
  {
    type: 'Credit Card',
    name: 'Low Rate Credit Card',
    annual_fee: 0,
    daily_limit: 0,
    credit_limit: 15000,
    interest_rate: 12.99,
    features: ['12.99% p.a. purchase rate', '55 interest-free days', 'Up to $15,000 limit', 'Fraud protection', 'Mobile wallet support'],
    image: '💳'
  },
  {
    type: 'Gold Credit',
    name: 'Gold Rewards Credit Card',
    annual_fee: 99,
    daily_limit: 0,
    credit_limit: 30000,
    interest_rate: 15.99,
    features: ['15.99% p.a. purchase rate', 'Reward points: 1.5/$1', 'Domestic travel insurance', 'Extended warranty', '2 lounge passes'],
    image: '🥇'
  },
  {
    type: 'Platinum Credit',
    name: 'Platinum Premium Credit Card',
    annual_fee: 299,
    daily_limit: 0,
    credit_limit: 75000,
    interest_rate: 18.99,
    features: ['18.99% p.a. purchase rate', 'Reward points: 3/$1', 'International insurance', 'Unlimited lounge', '24/7 concierge'],
    image: '💎'
  }
];

function buildCardTypeViewModel(cardType) {
  const isCredit = cardType.type.includes('Credit');
  return {
    ...cardType,
    desc: isCredit
      ? `Premium ${cardType.name.toLowerCase()} with flexible credit access and Australian support.`
      : `${cardType.name} for everyday banking, contactless purchases, and ATM access across Australia.`,
    fee: isCredit ? `$${cardType.annual_fee} / year` : `$${cardType.annual_fee} / year`,
    fee_raw: cardType.annual_fee || 0,
    interest: isCredit ? `${cardType.interest_rate.toFixed(2)}% p.a.` : 'No purchase interest',
    limit: isCredit
      ? `$${(cardType.credit_limit || 0).toLocaleString()} credit`
      : `$${(cardType.daily_limit || 0).toLocaleString()} daily`,
    limit_raw: isCredit ? (cardType.credit_limit || 0) : (cardType.daily_limit || 0)
  };
}

router.get('/', requireAuth, (req, res) => {
  const cards = db.prepare(`
    SELECT c.*, a.account_number, a.account_name
    FROM cards c
    JOIN accounts a ON c.account_id = a.id
    WHERE c.user_id = ?
    ORDER BY c.requested_at DESC
  `).all(req.session.userId);

  res.render('cards/index', {
    title: 'My Cards - United Credit Bank',
    page: 'cards',
    cards,
    cardTypes: CARD_TYPES.map(buildCardTypeViewModel),
    user: db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
  });
});

router.get('/apply/new', requireAuth, (req, res) => {
  const query = req.query.type ? `?type=${encodeURIComponent(req.query.type)}` : '';
  res.redirect(`/cards/apply${query}`);
});

router.get('/apply', requireAuth, requireVerified, (req, res) => {
  const accounts = getUserAccounts(req.session.userId, { operableOnly: true });
  const kyc = db.prepare('SELECT * FROM kyc WHERE user_id = ? AND status = ?').get(req.session.userId, 'approved');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const cardTypes = CARD_TYPES.map(buildCardTypeViewModel);
  const selectedCardType = cardTypes.find(card => card.type === req.query.type)?.type || cardTypes[0]?.type || null;

  res.render('cards/apply', {
    title: 'Apply for Card - United Credit Bank',
    page: 'cards',
    accounts,
    cardTypes,
    selectedCardType,
    isVerified: !!kyc,
    user
  });
});

router.post('/apply', requireAuth, requireVerified, (req, res) => {
  const { card_type, account_id, delivery_address, pin, cardholder_name, credit_limit } = req.body;

  const cardType = CARD_TYPES.find(t => t.type === card_type);
  if (!cardType) {
    req.session.error = 'Invalid card type.';
    return res.redirect('/cards/apply');
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(account_id, req.session.userId);
  if (!account) {
    req.session.error = 'Invalid account selected.';
    return res.redirect('/cards/apply');
  }

  const restrictionMessage = getAccountStatusMessage(account, 'apply for a card');
  if (restrictionMessage) {
    req.session.error = restrictionMessage;
    return res.redirect('/cards/apply');
  }

  const user = db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.session.userId);
  const cardNumber = generateCardNumber();
  const cvv = generateCVV();
  const expiryDate = `12/${new Date().getFullYear() + 4}`;
  const hashedPin = pin ? require('bcryptjs').hashSync(pin, 8) : null;

  const status = cardType.type.includes('Credit') ? 'pending' : 'pending';

  const insert = db.prepare(`
    INSERT INTO cards (user_id, account_id, card_type, card_number, cardholder_name, expiry_date, cvv, pin, daily_limit, credit_limit, available_credit, status, delivery_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    req.session.userId,
    account_id,
    cardType.type,
    cardNumber,
    cardholder_name || `${user.first_name} ${user.last_name}`,
    expiryDate,
    cvv,
    hashedPin,
    cardType.daily_limit || 2000,
    cardType.type.includes('Credit') && credit_limit ? parseFloat(credit_limit) : (cardType.credit_limit || 0),
    cardType.type.includes('Credit') && credit_limit ? parseFloat(credit_limit) : (cardType.credit_limit || 0),
    status,
    delivery_address || 'On hold - Collect at branch'
  );

  addNotification(req.session.userId, 'Card Application Submitted', `Your ${cardType.name} application is being reviewed.`, 'info');
  req.session.success = `Your ${cardType.name} application has been submitted successfully! You will be notified once approved.`;
  res.redirect('/cards');
});

router.get('/:id', requireAuth, (req, res) => {
  const card = db.prepare(`
    SELECT c.*, a.account_number, a.account_name,
      c.requested_at as applied_at,
      c.approved_at as issued_at
    FROM cards c
    JOIN accounts a ON c.account_id = a.id
    WHERE c.id = ? AND c.user_id = ?
  `).get(req.params.id, req.session.userId);

  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  res.render('cards/detail', {
    title: `${card.card_type} - United Credit Bank`,
    page: 'cards',
    card,
    user: db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
  });
});

router.post('/:id/activate', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card || card.status !== 'approved') {
    req.session.error = 'Cannot activate this card.';
    return res.redirect('/cards');
  }

  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('active', req.params.id);
  addNotification(req.session.userId, 'Card Activated', `Your ${card.card_type} is now active.`, 'success');
  req.session.success = 'Card activated successfully!';
  res.redirect(`/cards/${req.params.id}`);
});

router.post('/:id/freeze', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  const newStatus = card.status === 'frozen' ? 'active' : 'frozen';
  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run(newStatus, req.params.id);
  addNotification(req.session.userId, `Card ${newStatus === 'frozen' ? 'Frozen' : 'Unfrozen'}`, `Your ${card.card_type} status has been updated.`, 'info');
  req.session.success = `Card ${newStatus === 'frozen' ? 'frozen' : 'unfrozen'} successfully.`;
  res.redirect(`/cards/${req.params.id}`);
});

router.get('/:id/freeze', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  const newStatus = card.status === 'frozen' ? 'active' : 'frozen';
  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run(newStatus, req.params.id);
  addNotification(req.session.userId, `Card ${newStatus === 'frozen' ? 'Frozen' : 'Unfrozen'}`, `Your ${card.card_type} status has been updated.`, 'info');
  req.session.success = `Card ${newStatus === 'frozen' ? 'frozen' : 'unfrozen'} successfully.`;
  res.redirect(`/cards/${req.params.id}`);
});

router.get('/:id/unfreeze', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('active', req.params.id);
  addNotification(req.session.userId, 'Card Unfrozen', `Your ${card.card_type} status has been updated.`, 'info');
  req.session.success = 'Card unfrozen successfully.';
  res.redirect(`/cards/${req.params.id}`);
});

router.post('/:id/report-lost', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('lost_stolen', req.params.id);
  addNotification(req.session.userId, 'Card Reported Lost/Stolen', `Your ${card.card_type} has been blocked. A replacement will be sent.`, 'warning');
  req.session.success = 'Card reported lost/stolen. A replacement card will be issued.';
  res.redirect('/cards');
});

router.get('/:id/report', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('lost_stolen', req.params.id);
  addNotification(req.session.userId, 'Card Reported Lost/Stolen', `Your ${card.card_type} has been blocked. A replacement will be sent.`, 'warning');
  req.session.success = 'Card reported lost/stolen. A replacement card will be issued.';
  res.redirect('/cards');
});

router.post('/:id/set-pin', requireAuth, (req, res) => {
  const { pin } = req.body;
  if (!pin || pin.length !== 4 || !/^\d+$/.test(pin)) {
    req.session.error = 'PIN must be exactly 4 digits.';
    return res.redirect(`/cards/${req.params.id}`);
  }

  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card || card.status !== 'active') {
    req.session.error = 'Cannot set PIN for this card.';
    return res.redirect('/cards');
  }

  const hashedPin = require('bcryptjs').hashSync(pin, 8);
  db.prepare('UPDATE cards SET pin = ? WHERE id = ?').run(hashedPin, req.params.id);
  req.session.success = 'PIN updated successfully!';
  res.redirect(`/cards/${req.params.id}`);
});

router.post('/:id/replace', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('replacement_issued', req.params.id);
  req.session.success = 'Replacement card requested. It will be mailed within 5-7 business days.';
  res.redirect('/cards');
});

router.get('/:id/replace', requireAuth, (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!card) {
    req.session.error = 'Card not found.';
    return res.redirect('/cards');
  }

  db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('replacement_issued', req.params.id);
  req.session.success = 'Replacement card requested. It will be mailed within 5-7 business days.';
  res.redirect('/cards');
});

module.exports = router;
