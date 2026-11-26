const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminWorkflows, normalizeUserProfile, normalizeAccountMetadata } = require('../services/admin-workflows');

function fakeRepository(initial, { seedDefaultAdmin = true } = {}) {
  let store = structuredClone(initial);
  store.users ||= {};
  store.admins ||= {};
  if (seedDefaultAdmin && !store.users.admin1) store.users.admin1 = { id: 'admin1', is_admin: 1 };
  if (seedDefaultAdmin && !store.admins.admin1) store.admins.admin1 = { id: 'admin1', active: true, role: 'admin' };
  return {
    data: () => structuredClone(store),
    async runTransaction(callback) {
      const working = structuredClone(store);
      const tx = {
        async get(collection, id) {
          return working[collection] && working[collection][id] ? structuredClone(working[collection][id]) : null;
        },
        async list(collection, filters = [], options = {}) {
          let records = Object.entries(working[collection] || {}).map(([id, record]) => ({ id, ...structuredClone(record) }));
          records = records.filter(record => filters.every(filter => record[filter.field] === filter.value));
          if (Number.isInteger(options.limit)) records = records.slice(0, options.limit);
          return records;
        },
        update(collection, id, changes) {
          if (!working[collection] || !working[collection][id]) throw new Error('missing document');
          Object.assign(working[collection][id], structuredClone(changes));
        },
        create(collection, id, value) {
          working[collection] ||= {};
          if (working[collection][id]) throw new Error('document already exists');
          working[collection][id] = structuredClone(value);
        }
      };
      const result = await callback(tx);
      store = working;
      return { result, commitTime: 'test' };
    }
  };
}

function makeOptions() {
  let counter = 0;
  return { clock: () => '2026-11-23T10:00:00.000Z', idFactory: () => `audit-${++counter}` };
}

test('profile corrections allow only contact/profile fields and require a reason', () => {
  assert.deepEqual(normalizeUserProfile({ first_name: ' Ada ', phone: '+61 400 111 222', reason: 'Customer requested correction' }), {
    changes: { first_name: 'Ada', phone: '+61 400 111 222' },
    reason: 'Customer requested correction'
  });
  assert.throws(() => normalizeUserProfile({ email: 'other@example.com', reason: 'Customer requested correction' }), /Unsupported field: email/);
  assert.throws(() => normalizeUserProfile({ is_admin: 1, reason: 'Customer requested correction' }), /Unsupported field: is_admin/);
  assert.throws(() => normalizeUserProfile({ first_name: 'A', reason: 'Too short' }), /between 2 and 80/);
  assert.throws(() => normalizeUserProfile({ city: 'Sydney' }), /reason between 8 and 500/);
});

test('account metadata corrections exclude financial and identity fields', () => {
  assert.deepEqual(normalizeAccountMetadata({ account_name: 'Ada Savings', branch: 'Sydney', reason: 'Correcting display label' }), {
    changes: { account_name: 'Ada Savings', branch: 'Sydney' },
    reason: 'Correcting display label'
  });
  assert.throws(() => normalizeAccountMetadata({ balance: '100.00', reason: 'Unauthorized balance edit' }), /Unsupported field: balance/);
  assert.throws(() => normalizeAccountMetadata({ account_number: '123', reason: 'Change number' }), /Unsupported field: account_number/);
});

test('profile updates and immutable audit entries commit in one Firestore transaction', async () => {
  const repo = fakeRepository({ users: { customer1: { id: 'customer1', email: 'old@example.com', is_admin: 0 } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const result = await workflows.updateUserProfile({
    actorId: 'admin1', targetId: 'customer1', ipAddress: '127.0.0.1',
    body: { first_name: 'Ada', phone: '+61 400 111 222', reason: 'Customer requested correction' }
  });
  assert.deepEqual(result, { changed: true, changedFields: ['first_name', 'phone'] });
  const data = repo.data();
  assert.equal(data.users.customer1.first_name, 'Ada');
  assert.equal(data.users.customer1.email, 'old@example.com');
  assert.equal(data.users.customer1.is_admin, 0);
  assert.equal(data.users.customer1.updated_at, '2026-11-23T10:00:00.000Z');
  assert.equal(data.audit_logs['audit-1'].admin_id, 'admin1');
  assert.equal(data.audit_logs['audit-1'].action, 'update_user_profile');
  assert.equal(data.audit_logs['audit-1'].target_id, 'customer1');
  assert.equal(data.audit_logs['audit-1'].details, JSON.stringify({ changed_fields: ['first_name', 'phone'], reason: 'Customer requested correction' }));
});

test('legacy profile actions retain numeric profile IDs while owner records and notifications use the Firebase UID', async () => {
  const repo = fakeRepository({ users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', first_name: 'Ada', last_name: 'Customer', is_admin: 0, is_frozen: 0, disabled: false } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await workflows.updateUserProfile({
    actorId: 'admin1', targetId: '3',
    body: { first_name: 'Ada', phone: '+61 400 111 222', reason: 'Customer requested correction' }
  });
  await workflows.createAccount({
    actorId: 'admin1', targetId: '3',
    body: { account_type: 'Everyday Savings', reason: 'Verified customer requested account', operation_id: 'legacy-account-opening-0001' }
  });
  await workflows.setUserFrozen({ actorId: 'admin1', targetId: '3', action: 'freeze', reason: 'Customer requested temporary pause' });
  await workflows.setUserFrozen({ actorId: 'admin1', targetId: '3', action: 'unfreeze', reason: 'Customer confirmed reactivation' });
  await workflows.disableCustomer({ actorId: 'admin1', targetId: '3', reason: 'Customer requested account closure' });
  await workflows.restoreCustomer({ actorId: 'admin1', targetId: '3', reason: 'Customer requested account restoration' });

  const data = repo.data();
  assert.equal(data.users['3'].first_name, 'Ada');
  assert.equal(Object.values(data.accounts)[0].user_id, 'ucb-3');
  assert.equal(Object.values(data.ledger_entries)[0].user_id, 'ucb-3');
  const accountAudit = Object.values(data.audit_logs).find(record => record.action === 'create_account');
  assert.equal(JSON.parse(accountAudit.details).user_id, 'ucb-3');
  assert.ok(Object.values(data.notifications).length >= 6);
  assert.ok(Object.values(data.notifications).every(record => record.user_id === 'ucb-3'));
  assert.ok(Object.values(data.audit_logs).filter(record => record.target_type === 'user').every(record => record.target_id === '3'));
});

test('direct numeric Firebase UID profiles retain the numeric UID as the financial owner after verified binding', async () => {
  const repo = fakeRepository({ users: { '12345': { id: '12345', firebase_uid: '12345', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0 } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await workflows.createAccount({
    actorId: 'admin1', targetId: '12345',
    body: { account_type: 'Everyday Savings', reason: 'Direct UID customer account', operation_id: 'direct-numeric-account-0001' }
  });
  assert.equal(Object.values(repo.data().accounts)[0].user_id, '12345');
});

test('legacy numeric customer operations fail closed until a verified Firebase UID binding exists', async () => {
  const repo = fakeRepository({ users: { '3': { id: '3', first_name: 'Ada', is_admin: 0, disabled: false } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await assert.rejects(() => workflows.createAccount({
    actorId: 'admin1', targetId: '3',
    body: { account_type: 'Everyday Savings', reason: 'Customer requested a new account', operation_id: 'legacy-unbound-account-0001' }
  }), /no verified Firebase UID binding/);
  assert.deepEqual(repo.data().accounts || {}, {});
  assert.deepEqual(repo.data().ledger_entries || {}, {});
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('administrator password-reset delivery fails closed when the target Firebase email cannot be verified currently', async () => {
  const repo = fakeRepository({ users: { customer1: { id: 'customer1', email: 'stale@example.test', is_admin: 0 } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await assert.rejects(() => workflows.recordPasswordResetRequest({
    actorId: 'admin1', targetId: 'customer1', reason: 'Customer requested a password reset'
  }), /current Firebase Auth email cannot be verified/);
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('user freeze changes are auditable, idempotent, and cannot target administrators or the acting admin', async () => {
  const repo = fakeRepository({ users: {
    customer1: { id: 'customer1', is_admin: 0, is_frozen: 0 },
    admin1: { id: 'admin1', is_admin: 1, is_frozen: 0 }
  } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const result = await workflows.setUserFrozen({ actorId: 'admin1', targetId: 'customer1', action: 'freeze', reason: 'Suspected unauthorized access', ipAddress: '127.0.0.1' });
  assert.deepEqual(result, { changed: true, frozen: true });
  assert.equal(repo.data().users.customer1.is_frozen, 1);
  assert.equal(repo.data().audit_logs['audit-1'].action, 'freeze_user');
  assert.deepEqual(await workflows.setUserFrozen({ actorId: 'admin1', targetId: 'customer1', action: 'freeze', reason: 'Duplicate freeze request' }), { changed: false });
  await assert.rejects(() => workflows.setUserFrozen({ actorId: 'admin1', targetId: 'admin1', action: 'freeze', reason: 'Prevent self lockout' }), /cannot freeze your own/);
  await assert.rejects(() => workflows.setUserFrozen({ actorId: 'admin1', targetId: 'admin1', action: 'unfreeze', reason: 'Admin account' }), /Administrator accounts cannot be frozen/);
});

test('account status changes permit only operational states and write audit entries atomically', async () => {
  const repo = fakeRepository({ accounts: {
    '1': { id: '1', status: 'active', balance: 500.25 },
    '2': { id: '2', status: 'closed', balance_minor: 0 },
    '3': { id: '3', status: 'restricted', balance: 10 }
  } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const result = await workflows.changeAccountStatus({ actorId: 'admin1', accountId: '1', status: 'frozen', reason: 'Customer reported stolen credentials', ipAddress: '127.0.0.1' });
  assert.deepEqual(result, { changed: true, previous: 'active', status: 'frozen' });
  assert.equal(repo.data().accounts['1'].status, 'frozen');
  assert.equal(repo.data().accounts['1'].balance, 500.25);
  assert.equal(repo.data().audit_logs['audit-1'].action, 'change_account_status');
  await assert.rejects(() => workflows.changeAccountStatus({ actorId: 'admin1', accountId: '1', status: 'closed', reason: 'Close account' }), /closure requires zero balance/);
  const reopened = await workflows.changeAccountStatus({ actorId: 'admin1', accountId: '1', status: 'active', reason: 'Reviewed freeze request' });
  assert.deepEqual(reopened, { changed: true, previous: 'frozen', status: 'active' });
  await assert.rejects(() => workflows.changeAccountStatus({ actorId: 'admin1', accountId: '2', status: 'active', reason: 'Reopen closed account' }), /Closed accounts cannot/);
  await assert.rejects(() => workflows.changeAccountStatus({ actorId: 'admin1', accountId: '3', status: 'frozen', reason: 'Review legacy status' }), /legacy account status requires review/);
  assert.equal(repo.data().accounts['3'].status, 'restricted');
});

test('account metadata update cannot mutate balances and closed accounts remain immutable', async () => {
  const repo = fakeRepository({ accounts: {
    '1': { id: '1', status: 'active', account_name: 'Old label', branch: 'Sydney', balance: 25.00 },
    '2': { id: '2', status: 'closed', account_name: 'Closed', branch: 'Sydney' }
  } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await workflows.updateAccountMetadata({ actorId: 'admin1', accountId: '1', body: { account_name: 'Updated label', reason: 'Correcting display name' } });
  assert.equal(repo.data().accounts['1'].account_name, 'Updated label');
  assert.equal(repo.data().accounts['1'].balance, 25.00);
  await assert.rejects(() => workflows.updateAccountMetadata({ actorId: 'admin1', accountId: '2', body: { branch: 'Melbourne', reason: 'Branch correction' } }), /Closed accounts cannot be edited/);
});

test('failed profile updates do not leave partial audit writes', async () => {
  const repo = fakeRepository({ users: {} });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await assert.rejects(() => workflows.updateUserProfile({
    actorId: 'admin1', targetId: 'missing', body: { first_name: 'Ada', reason: 'Customer requested correction' }
  }), /Customer not found/);
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('audit reasons and account status values reject non-string input', async () => {
  const repo = fakeRepository({ accounts: { '1': { id: '1', status: 'active' } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await assert.rejects(() => workflows.changeAccountStatus({ actorId: 'admin1', accountId: '1', status: ['active'], reason: 'Valid length reason' }), /Choose active, frozen, blocked, or closed status/);
  await assert.rejects(() => workflows.updateAccountMetadata({ actorId: 'admin1', accountId: '1', body: { branch: 'Sydney', reason: ['eight', 'words'] } }), /reason between 8 and 500 characters/);
  assert.equal(repo.data().accounts['1'].status, 'active');
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('each transaction rejects writes after the acting administrator is demoted', async () => {
  const repo = fakeRepository({ accounts: { '1': { id: '1', status: 'active' } } });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await repo.runTransaction(async tx => tx.update('admins', 'admin1', { active: false }));
  await assert.rejects(() => workflows.changeAccountStatus({ actorId: 'admin1', accountId: '1', status: 'frozen', reason: 'Customer reported stolen credentials' }), /Administrator permissions are no longer active/);
  assert.equal(repo.data().accounts['1'].status, 'active');
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('missing admins document rejects writes even if a duplicate users profile has administrator flags', async () => {
  const repo = fakeRepository({
    users: { admin1: { id: 'admin1', is_admin: 1, role: 'super_admin' } },
    accounts: { '1': { id: '1', status: 'active' } }
  }, { seedDefaultAdmin: false });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await assert.rejects(() => workflows.changeAccountStatus({ actorId: 'admin1', accountId: '1', status: 'frozen', reason: 'Customer reported stolen credentials' }), /Administrator permissions are no longer active/);
  assert.equal(repo.data().accounts['1'].status, 'active');
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('transactional admin writes accept an active super_admin record keyed by Firebase UID', async () => {
  const repo = fakeRepository({
    admins: { admin1: { active: true, role: 'super_admin', is_super_admin: true } },
    accounts: { '1': { id: '1', status: 'active' } }
  }, { seedDefaultAdmin: false });
  const workflows = createAdminWorkflows(repo, makeOptions());

  const result = await workflows.changeAccountStatus({
    actorId: 'admin1', accountId: '1', status: 'frozen', reason: 'Customer reported stolen credentials'
  });

  assert.equal(result.changed, true);
  assert.equal(repo.data().accounts['1'].status, 'frozen');
  assert.equal(Object.values(repo.data().audit_logs)[0].admin_id, 'admin1');
});

test('inactive admins record blocks transactional writes even if a duplicate users profile has admin privileges', async () => {
  const repo = fakeRepository({
    admins: { admin1: { active: false, role: 'super_admin', is_super_admin: true } },
    accounts: { '1': { id: '1', status: 'active' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());

  await assert.rejects(() => workflows.changeAccountStatus({
    actorId: 'admin1', accountId: '1', status: 'frozen', reason: 'Customer reported stolen credentials'
  }), /Administrator permissions are no longer active/);
  assert.equal(repo.data().accounts['1'].status, 'active');
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('balance adjustments are idempotent and atomically append a transaction, ledger, notification, and audit record', async () => {
  const repo = fakeRepository({
    users: { customer1: { id: 'customer1', is_admin: 0 } },
    accounts: { acc1: { id: 'acc1', user_id: 'customer1', status: 'active', currency: 'AUD', balance_minor: 100000, available_balance_minor: 80000 } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const operation = {
    actorId: 'admin1', accountId: 'acc1', ipAddress: '127.0.0.1',
    body: { account_id: 'acc1', adjustment_type: 'credit', amount: '25.50', reference: 'CASE-1082', reason: 'Verified deposit correction', operation_id: 'operation-credit-0001' }
  };
  const first = await workflows.adjustAccountBalance(operation);
  const replay = await workflows.adjustAccountBalance(operation);
  assert.equal(first.changed, true);
  assert.deepEqual(replay, { ...first, replayed: true });
  const data = repo.data();
  assert.equal(data.accounts.acc1.balance_minor, 102550);
  assert.equal(data.accounts.acc1.available_balance_minor, 82550);
  assert.equal(Object.keys(data.transactions).length, 1);
  assert.equal(Object.keys(data.ledger_entries).length, 1);
  assert.equal(Object.keys(data.audit_logs).length, 1);
  assert.equal(data.transactions['audit-1'].amount_minor, 2550);
  assert.equal(data.ledger_entries['audit-2'].balance_after_minor, 102550);
  assert.equal(data.admin_operations['operation-credit-0001'].action, 'adjust_account_balance');
  await assert.rejects(() => workflows.adjustAccountBalance({ ...operation, body: { ...operation.body, operation_id: 'operation-debit-0001', adjustment_type: 'debit', amount: '900.00' } }), /Debit exceeds the available balance/);
});

test('balance adjustment on a legacy-profile-owned account writes transaction, ledger, and notification under its verified Firebase UID', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0 } },
    accounts: { acc1: { id: 'acc1', user_id: '3', status: 'active', currency: 'AUD', balance_minor: 100000, available_balance_minor: 100000 } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await workflows.adjustAccountBalance({
    actorId: 'admin1', accountId: 'acc1',
    body: { account_id: 'acc1', adjustment_type: 'credit', amount: '10.00', reference: 'CASE-LEGACY-1', reason: 'Verified legacy account correction', operation_id: 'legacy-owner-adjustment-0001' }
  });
  const data = repo.data();
  assert.equal(data.accounts.acc1.balance_minor, 101000);
  assert.ok(Object.values(data.transactions).every(record => record.user_id === 'ucb-3'));
  assert.ok(Object.values(data.ledger_entries).every(record => record.user_id === 'ucb-3'));
  assert.ok(Object.values(data.notifications).every(record => record.user_id === 'ucb-3'));
});

test('pending reserved transfers settle only with a verified reference and rejection releases the hold into the ledger', async () => {
  const fixture = () => fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0 } },
    accounts: { acc1: { id: 'acc1', user_id: 'ucb-3', status: 'active', currency: 'AUD', balance_minor: 100000, available_balance_minor: 95000 } },
    transactions: { txn1: { id: 'txn1', user_id: 'ucb-3', account_id: 'acc1', transaction_type: 'local_transfer', amount_minor: 5000, fee_minor: 0, status: 'pending', currency: 'AUD' } },
    ledger_entries: { hold1: { id: 'hold1', transaction_id: 'txn1', entry_type: 'debit', amount_minor: 5000, status: 'pending' } }
  });
  const approveRepo = fixture();
  const approve = createAdminWorkflows(approveRepo, makeOptions());
  await assert.rejects(() => approve.reviewTransaction({ actorId: 'admin1', transactionId: 'txn1', action: 'approve', body: { reason: 'Verified transfer release' } }), /Settlement reference/);
  await approve.reviewTransaction({ actorId: 'admin1', transactionId: 'txn1', action: 'approve', body: { reason: 'Verified transfer release', settlement_reference: 'BANK-SETTLE-1001' } });
  assert.equal(approveRepo.data().accounts.acc1.balance_minor, 95000);
  assert.equal(approveRepo.data().accounts.acc1.available_balance_minor, 95000);
  assert.equal(approveRepo.data().transactions.txn1.status, 'completed');
  assert.equal(approveRepo.data().transactions.txn1.settlement_reference, 'BANK-SETTLE-1001');
  assert.equal(approveRepo.data().transactions.txn1.user_id, 'ucb-3');

  const rejectRepo = fixture();
  const reject = createAdminWorkflows(rejectRepo, makeOptions());
  await reject.reviewTransaction({ actorId: 'admin1', transactionId: 'txn1', action: 'reject', body: { reason: 'Beneficiary details could not be confirmed' } });
  const rejected = rejectRepo.data();
  assert.equal(rejected.accounts.acc1.balance_minor, 100000);
  assert.equal(rejected.accounts.acc1.available_balance_minor, 100000);
  assert.equal(rejected.transactions.txn1.status, 'rejected');
  assert.equal(rejected.transactions.txn1.approved_by, undefined);
  assert.ok(Object.values(rejected.ledger_entries).some(entry => entry.entry_type === 'hold_release' && entry.amount_minor === 5000));
});

test('admin settlement matches mixed UID/profile-ID transaction, bill, and account owners but writes new ledgers and notifications by UID', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0, disabled: false } },
    accounts: { acc1: { id: 'acc1', user_id: '3', status: 'active', currency: 'AUD', balance_minor: 20000, available_balance_minor: 20000 } },
    transactions: { txn1: { id: 'txn1', user_id: 'ucb-3', account_id: 'acc1', transaction_type: 'bill_payment', amount_minor: 10000, status: 'pending', currency: 'AUD' } },
    bill_payments: { bill1: { id: 'bill1', user_id: '3', account_id: 'acc1', amount_minor: 10000, status: 'pending' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await workflows.reviewTransaction({
    actorId: 'admin1', transactionId: 'txn1', action: 'approve',
    body: { reason: 'Matched bill payment records across the verified owner IDs', settlement_reference: 'BILL-SETTLE-1003' }
  });
  const data = repo.data();
  assert.equal(data.accounts.acc1.balance_minor, 10000);
  assert.equal(data.accounts.acc1.available_balance_minor, 10000);
  assert.equal(data.transactions.txn1.status, 'completed');
  assert.equal(data.bill_payments.bill1.status, 'completed');
  assert.ok(Object.values(data.ledger_entries).every(entry => entry.user_id === 'ucb-3'));
  assert.ok(Object.values(data.notifications).every(notification => notification.user_id === 'ucb-3'));
});

test('settlement fails closed when a UID-owned transaction has no verified numeric-profile binding', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', is_admin: 0 } },
    accounts: { acc1: { id: 'acc1', user_id: 'ucb-3', status: 'active', currency: 'AUD', balance_minor: 100000, available_balance_minor: 95000 } },
    transactions: { txn1: { id: 'txn1', user_id: 'ucb-3', account_id: 'acc1', transaction_type: 'local_transfer', amount_minor: 5000, status: 'pending', currency: 'AUD' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await assert.rejects(() => workflows.reviewTransaction({
    actorId: 'admin1', transactionId: 'txn1', action: 'reject', body: { reason: 'Unbound customer ownership' }
  }), /Customer record is unavailable/);
  assert.equal(repo.data().transactions.txn1.status, 'pending');
  assert.equal(repo.data().accounts.acc1.balance_minor, 100000);
  assert.deepEqual(repo.data().audit_logs || {}, {});
});

test('partially reserved transfers subtract only the unreserved amount from available funds', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0 } },
    accounts: { acc1: { id: 'acc1', user_id: 'ucb-3', status: 'active', currency: 'AUD', balance_minor: 100000, available_balance_minor: 90000 } },
    transactions: { txn1: { id: 'txn1', user_id: 'ucb-3', account_id: 'acc1', transaction_type: 'local_transfer', amount_minor: 5000, status: 'pending', reserved_minor: 2500, currency: 'AUD' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  await workflows.reviewTransaction({ actorId: 'admin1', transactionId: 'txn1', action: 'approve', body: { reason: 'Verified partial transfer hold', settlement_reference: 'BANK-PARTIAL-1002' } });
  assert.equal(repo.data().accounts.acc1.balance_minor, 95000);
  assert.equal(repo.data().accounts.acc1.available_balance_minor, 87500);
});

test('KYC approval requires evidence for real Firebase Storage object paths', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0, is_verified: 0 } },
    kyc: { kyc1: { id: 'kyc1', user_id: 'ucb-3', document_type: 'Drivers Licence', document_front: 'kyc/ucb-3/kyc1/front.pdf', document_back: 'kyc/ucb-3/kyc1/back.pdf', status: 'pending' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const request = { actorId: 'admin1', recordId: 'kyc1', action: 'approve', body: { reason: 'Documents verified against customer profile' } };
  await assert.rejects(() => workflows.reviewKyc(request), /Open and verify the submitted identity files/);
  const result = await workflows.reviewKyc({ ...request, documentEvidence: { document_front: 'kyc/ucb-3/kyc1/front.pdf', document_back: 'kyc/ucb-3/kyc1/back.pdf' } });
  assert.equal(result.status, 'approved');
  assert.equal(repo.data().users['3'].is_verified, 1);
  assert.equal(repo.data().kyc.kyc1.user_id, 'ucb-3');
  assert.equal(repo.data().kyc.kyc1.reviewed_by, 'admin1');
});

test('card approvals remain non-activatable until manual issuer fulfillment and status changes are audited', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0, is_verified: 0, is_frozen: 0 } },
    accounts: { acc1: { id: 'acc1', user_id: '3', status: 'active', balance_minor: 0, available_balance_minor: 0 } },
    kyc: { kyc1: { id: 'kyc1', user_id: '3', status: 'approved' } },
    cards: { card1: { id: 'card1', user_id: 'ucb-3', account_id: 'acc1', card_type: 'Debit Card', status: 'pending' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const result = await workflows.reviewCard({ actorId: 'admin1', cardId: 'card1', action: 'approve', body: { reason: 'Application passed identity review' } });
  assert.equal(result.status, 'awaiting_issuer');
  assert.equal(repo.data().cards.card1.fulfillment_status, 'manual_pending');
  assert.equal(repo.data().cards.card1.user_id, 'ucb-3');
  assert.ok(Object.values(repo.data().notifications).every(notification => notification.user_id === 'ucb-3'));
  await assert.rejects(() => workflows.changeCardStatus({ actorId: 'admin1', cardId: 'card1', status: 'active', reason: 'Activation attempted before issuance' }), /Issuer fulfillment must be confirmed/);
  const frozen = await workflows.changeCardStatus({ actorId: 'admin1', cardId: 'card1', status: 'frozen', reason: 'Hold pending issuer investigation' });
  assert.equal(frozen.status, 'frozen');
  await assert.rejects(() => workflows.changeCardStatus({ actorId: 'admin1', cardId: 'card1', status: 'active', reason: 'Activation attempted before issuer fulfillment' }), /Issuer fulfillment must be confirmed/);
  await repo.runTransaction(tx => tx.update('cards', 'card1', { fulfillment_status: 'issued' }));
  const active = await workflows.changeCardStatus({ actorId: 'admin1', cardId: 'card1', status: 'active', reason: 'Issuer fulfillment independently confirmed' });
  assert.equal(active.status, 'active');
});

test('loan approval requires funding evidence and atomically credits only the owned account with ledger and audit records', async () => {
  const repo = fakeRepository({
    users: { '3': { id: '3', firebase_uid: 'ucb-3', firebase_uid_verified_at: '2026-11-25T10:00:00.000Z', is_admin: 0, is_verified: 1, disabled: false } },
    accounts: { acc1: { id: 'acc1', user_id: '3', status: 'active', currency: 'AUD', balance_minor: 500000, available_balance_minor: 500000 } },
    loans: { loan1: { id: 'loan1', user_id: 'ucb-3', account_id: 'acc1', loan_type: 'Personal Loan', loan_amount_minor: 200000, remaining_balance_minor: 200000, loan_term_months: 12, interest_rate: 10, status: 'pending' } }
  });
  const workflows = createAdminWorkflows(repo, makeOptions());
  const request = { actorId: 'admin1', loanId: 'loan1', action: 'approve', body: { reason: 'Approved after underwriting review' } };
  await assert.rejects(() => workflows.reviewLoan(request), /Settlement reference/);
  const result = await workflows.reviewLoan({ ...request, body: { ...request.body, settlement_reference: 'FUNDING-REF-2031' } });
  const data = repo.data();
  assert.equal(result.status, 'disbursed');
  assert.equal(data.accounts.acc1.balance_minor, 700000);
  assert.equal(data.accounts.acc1.available_balance_minor, 700000);
  assert.equal(data.loans.loan1.status, 'disbursed');
  assert.equal(data.loans.loan1.user_id, 'ucb-3');
  assert.equal(data.loans.loan1.settlement_reference, 'FUNDING-REF-2031');
  assert.equal(Object.values(data.transactions)[0].transaction_type, 'loan_disbursement');
  assert.equal(Object.values(data.transactions)[0].user_id, 'ucb-3');
  assert.ok(Object.values(data.notifications).every(notification => notification.user_id === 'ucb-3'));
  assert.equal(Object.values(data.ledger_entries)[0].amount_minor, 200000);
  assert.ok(Object.values(data.audit_logs)[0].details.includes('FUNDING-REF-2031'));
});
