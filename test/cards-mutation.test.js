const { test } = require('node:test');
const assert = require('node:assert/strict');
const cardsRouter = require('../routes/cards');

const mutateCard = cardsRouter.mutateCard;
const verifiedUser = {
  id: '3', profileId: '3', uid: 'ucb-3', firebaseUid: 'ucb-3',
  firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z'
};

function transactionRepository(card) {
  const writes = [];
  return {
    writes,
    async runTransaction(callback) {
      const result = await callback({
        async get(collection, id) {
          assert.equal(collection, 'cards');
          assert.equal(id, 'card-1');
          return card;
        },
        update(collection, id, changes) { writes.push({ collection, id, changes }); },
        create(collection, id, data) { writes.push({ collection, id, data }); }
      });
      return { result, commitTime: 'test' };
    }
  };
}

test('card mutation returns no record and makes no write when the card has another owner', async () => {
  const repository = transactionRepository({ id: 'card-1', user_id: 'another-customer', status: 'active' });
  const req = {
    params: { id: 'card-1' },
    auth: { uid: 'ucb-3' },
    session: { userId: 'ucb-3', profileId: '3' },
    user: verifiedUser
  };
  const card = await mutateCard(repository, req, () => ({ fields: { status: 'frozen' } }));
  assert.equal(card, null);
  assert.deepEqual(repository.writes, []);
});

test('card mutation returns the transaction result for an explicitly owned legacy card', async () => {
  const repository = transactionRepository({ id: 'card-1', user_id: '3', status: 'approved' });
  const req = {
    params: { id: 'card-1' },
    auth: { uid: 'ucb-3' },
    session: { userId: 'ucb-3', profileId: '3' },
    user: verifiedUser
  };
  const card = await mutateCard(repository, req, item => item.status === 'approved' ? { fields: { status: 'active' } } : null);
  assert.equal(card.status, 'active');
  assert.equal(repository.writes[0].changes.status, 'active');
});
