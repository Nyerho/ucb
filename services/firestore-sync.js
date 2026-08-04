const { db } = require('../database');
const { getFirestore, hasAdminCredentials, logFirestoreDiagnostics, getResolvedProjectId } = require('../lib/firebase-admin');

const USERS_COLLECTION = process.env.FIRESTORE_USERS_COLLECTION || 'users';
const ACCOUNTS_COLLECTION = process.env.FIRESTORE_ACCOUNTS_COLLECTION || 'accounts';
const ADMINS_COLLECTION = process.env.FIREBASE_ADMIN_COLLECTION || 'admins';
const ADMIN_DOC_ID = process.env.FIREBASE_ADMIN_DOC_ID || null;

function isFirestoreEnabled() {
  const enabled = hasAdminCredentials() && Boolean(getFirestore());
  if (!enabled) {
    logFirestoreDiagnostics();
  }
  return enabled;
}

function normalizeDateString(value) {
  if (!value) {
    return null;
  }

  if (value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = String(value).trim().replace(' ', 'T');
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
  const iso = withSeconds.endsWith('Z') ? withSeconds : `${withSeconds}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function toSqlDateTime(value) {
  const iso = normalizeDateString(value);
  return iso ? iso.slice(0, 19).replace('T', ' ') : null;
}

function toFirestoreDate(value) {
  const iso = normalizeDateString(value);
  return iso ? new Date(iso) : new Date();
}

function normalizeAdminFlag(value) {
  return asInt(value) === 1 ? 1 : 0;
}

function normalizeUserRole(user) {
  const isAdmin = normalizeAdminFlag(user && user.is_admin) === 1;
  const role = String((user && user.role) || '').trim().toLowerCase();

  if (isAdmin) {
    return role && role !== 'customer' ? role : 'super_admin';
  }

  return 'customer';
}

function asInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asFloat(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFirestoreUser(user) {
  const isAdmin = normalizeAdminFlag(user.is_admin);

  return {
    sql_id: asInt(user.id),
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    email: (user.email || '').trim().toLowerCase(),
    phone: user.phone || '',
    password: user.password || '',
    address: user.address || '',
    city: user.city || '',
    state: user.state || '',
    postcode: user.postcode || '',
    country: user.country || 'Australia',
    date_of_birth: user.date_of_birth || null,
    profile_image: user.profile_image || '',
    is_admin: isAdmin,
    is_verified: asInt(user.is_verified),
    is_frozen: asInt(user.is_frozen),
    role: normalizeUserRole(user),
    transfer_pin_hash: user.transfer_pin_hash || '',
    transfer_pin_updated_at: normalizeDateString(user.transfer_pin_updated_at),
    last_login: normalizeDateString(user.last_login),
    created_at: normalizeDateString(user.created_at) || new Date().toISOString(),
    updated_at: normalizeDateString(user.updated_at) || new Date().toISOString(),
    created_at_ts: toFirestoreDate(user.created_at),
    updated_at_ts: toFirestoreDate(user.updated_at),
    last_login_ts: user.last_login ? toFirestoreDate(user.last_login) : null
  };
}

function toFirestoreAccount(account) {
  return {
    sql_id: asInt(account.id),
    user_id: asInt(account.user_id),
    user_ref: String(account.user_id),
    account_number: account.account_number || '',
    account_type: account.account_type || '',
    account_name: account.account_name || '',
    currency: account.currency || 'AUD',
    balance: asFloat(account.balance),
    available_balance: asFloat(account.available_balance),
    interest_rate: asFloat(account.interest_rate),
    status: account.status || 'active',
    branch: account.branch || 'Sydney CBD',
    bsb: account.bsb || '082-987',
    opened_date: normalizeDateString(account.opened_date) || new Date().toISOString(),
    opened_date_ts: toFirestoreDate(account.opened_date),
    updated_at: new Date().toISOString(),
    updated_at_ts: new Date()
  };
}

const TRANSACTIONS_COLLECTION = process.env.FIRESTORE_TRANSACTIONS_COLLECTION || 'transactions';

function toFirestoreTransaction(txn) {
  return {
    sql_id: asInt(txn.id),
    account_id: asInt(txn.account_id),
    user_id: asInt(txn.user_id),
    account_ref: String(txn.account_id),
    user_ref: String(txn.user_id),
    transaction_type: txn.transaction_type || '',
    amount: asFloat(txn.amount),
    currency: txn.currency || 'AUD',
    description: txn.description || '',
    reference: txn.reference || '',
    recipient_name: txn.recipient_name || '',
    recipient_account: txn.recipient_account || '',
    recipient_bsb: txn.recipient_bsb || '',
    recipient_bank: txn.recipient_bank || '',
    swift_code: txn.swift_code || '',
    iban: txn.iban || '',
    country: txn.country || 'Australia',
    status: txn.status || 'pending',
    fee: asFloat(txn.fee),
    exchange_rate: txn.exchange_rate ? asFloat(txn.exchange_rate) : null,
    converted_amount: txn.converted_amount ? asFloat(txn.converted_amount) : null,
    approved_by: txn.approved_by ? asInt(txn.approved_by) : null,
    approved_at: normalizeDateString(txn.approved_at),
    approved_at_ts: txn.approved_at ? toFirestoreDate(txn.approved_at) : null,
    rejection_reason: txn.rejection_reason || '',
    created_at: normalizeDateString(txn.created_at) || new Date().toISOString(),
    created_at_ts: toFirestoreDate(txn.created_at),
    updated_at: new Date().toISOString(),
    updated_at_ts: new Date()
  };
}

function upsertLocalUser(userDoc, explicitId) {
  const userId = asInt(userDoc.sql_id || explicitId || userDoc.id);
  if (!userId) {
    return null;
  }

  const isAdmin = normalizeAdminFlag(userDoc.is_admin);

  const payload = {
    id: userId,
    first_name: userDoc.first_name || '',
    last_name: userDoc.last_name || '',
    email: (userDoc.email || '').trim().toLowerCase(),
    phone: userDoc.phone || '',
    password: userDoc.password || '',
    address: userDoc.address || '',
    city: userDoc.city || '',
    state: userDoc.state || '',
    postcode: userDoc.postcode || '',
    country: userDoc.country || 'Australia',
    date_of_birth: userDoc.date_of_birth || null,
    profile_image: userDoc.profile_image || '',
    is_admin: isAdmin,
    is_verified: asInt(userDoc.is_verified),
    is_frozen: asInt(userDoc.is_frozen),
    created_at: toSqlDateTime(userDoc.created_at) || toSqlDateTime(new Date()),
    updated_at: toSqlDateTime(userDoc.updated_at) || toSqlDateTime(new Date()),
    role: normalizeUserRole(userDoc),
    transfer_pin_hash: userDoc.transfer_pin_hash || null,
    transfer_pin_updated_at: toSqlDateTime(userDoc.transfer_pin_updated_at),
    last_login: toSqlDateTime(userDoc.last_login)
  };

  db.prepare(`
    INSERT INTO users (
      id, first_name, last_name, email, phone, password, address, city, state, postcode,
      country, date_of_birth, profile_image, is_admin, is_verified, is_frozen, created_at,
      updated_at, role, transfer_pin_hash, transfer_pin_updated_at, last_login
    )
    VALUES (
      @id, @first_name, @last_name, @email, @phone, @password, @address, @city, @state, @postcode,
      @country, @date_of_birth, @profile_image, @is_admin, @is_verified, @is_frozen, @created_at,
      @updated_at, @role, @transfer_pin_hash, @transfer_pin_updated_at, @last_login
    )
    ON CONFLICT(id) DO UPDATE SET
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      email = excluded.email,
      phone = excluded.phone,
      password = excluded.password,
      address = excluded.address,
      city = excluded.city,
      state = excluded.state,
      postcode = excluded.postcode,
      country = excluded.country,
      date_of_birth = excluded.date_of_birth,
      profile_image = excluded.profile_image,
      is_admin = excluded.is_admin,
      is_verified = excluded.is_verified,
      is_frozen = excluded.is_frozen,
      updated_at = excluded.updated_at,
      role = excluded.role,
      transfer_pin_hash = excluded.transfer_pin_hash,
      transfer_pin_updated_at = excluded.transfer_pin_updated_at,
      last_login = excluded.last_login
  `).run(payload);

  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function upsertLocalAccount(accountDoc, explicitId) {
  const accountId = asInt(accountDoc.sql_id || explicitId || accountDoc.id);
  const userId = asInt(accountDoc.user_id || accountDoc.user_ref);
  if (!accountId || !userId) {
    return null;
  }

  const payload = {
    id: accountId,
    user_id: userId,
    account_number: accountDoc.account_number || '',
    account_type: accountDoc.account_type || 'Everyday Savings',
    account_name: accountDoc.account_name || '',
    currency: accountDoc.currency || 'AUD',
    balance: asFloat(accountDoc.balance),
    available_balance: asFloat(accountDoc.available_balance),
    interest_rate: asFloat(accountDoc.interest_rate),
    status: accountDoc.status || 'active',
    branch: accountDoc.branch || 'Sydney CBD',
    bsb: accountDoc.bsb || '082-987',
    opened_date: toSqlDateTime(accountDoc.opened_date) || toSqlDateTime(new Date())
  };

  db.prepare(`
    INSERT INTO accounts (
      id, user_id, account_number, account_type, account_name, currency, balance,
      available_balance, interest_rate, status, branch, bsb, opened_date
    )
    VALUES (
      @id, @user_id, @account_number, @account_type, @account_name, @currency, @balance,
      @available_balance, @interest_rate, @status, @branch, @bsb, @opened_date
    )
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      account_number = excluded.account_number,
      account_type = excluded.account_type,
      account_name = excluded.account_name,
      currency = excluded.currency,
      balance = excluded.balance,
      available_balance = excluded.available_balance,
      interest_rate = excluded.interest_rate,
      status = excluded.status,
      branch = excluded.branch,
      bsb = excluded.bsb,
      opened_date = excluded.opened_date
  `).run(payload);

  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
}

function upsertLocalTransaction(txnDoc, explicitId) {
  const txnId = asInt(txnDoc.sql_id || explicitId || txnDoc.id);
  const accountId = asInt(txnDoc.account_id || txnDoc.account_ref);
  const userId = asInt(txnDoc.user_id || txnDoc.user_ref);
  if (!txnId || !accountId || !userId) {
    return null;
  }

  const payload = {
    id: txnId,
    account_id: accountId,
    user_id: userId,
    transaction_type: txnDoc.transaction_type || '',
    amount: asFloat(txnDoc.amount),
    currency: txnDoc.currency || 'AUD',
    description: txnDoc.description || '',
    reference: txnDoc.reference || '',
    recipient_name: txnDoc.recipient_name || '',
    recipient_account: txnDoc.recipient_account || '',
    recipient_bsb: txnDoc.recipient_bsb || '',
    recipient_bank: txnDoc.recipient_bank || '',
    swift_code: txnDoc.swift_code || '',
    iban: txnDoc.iban || '',
    country: txnDoc.country || 'Australia',
    status: txnDoc.status || 'pending',
    fee: asFloat(txnDoc.fee),
    exchange_rate: txnDoc.exchange_rate ? asFloat(txnDoc.exchange_rate) : null,
    converted_amount: txnDoc.converted_amount ? asFloat(txnDoc.converted_amount) : null,
    approved_by: txnDoc.approved_by ? asInt(txnDoc.approved_by) : null,
    approved_at: toSqlDateTime(txnDoc.approved_at),
    rejection_reason: txnDoc.rejection_reason || '',
    created_at: toSqlDateTime(txnDoc.created_at) || toSqlDateTime(new Date())
  };

  db.prepare(`
    INSERT INTO transactions (
      id, account_id, user_id, transaction_type, amount, currency, description, reference,
      recipient_name, recipient_account, recipient_bsb, recipient_bank, swift_code, iban,
      country, status, fee, exchange_rate, converted_amount, approved_by, approved_at,
      rejection_reason, created_at
    )
    VALUES (
      @id, @account_id, @user_id, @transaction_type, @amount, @currency, @description, @reference,
      @recipient_name, @recipient_account, @recipient_bsb, @recipient_bank, @swift_code, @iban,
      @country, @status, @fee, @exchange_rate, @converted_amount, @approved_by, @approved_at,
      @rejection_reason, @created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      account_id = excluded.account_id,
      user_id = excluded.user_id,
      transaction_type = excluded.transaction_type,
      amount = excluded.amount,
      currency = excluded.currency,
      description = excluded.description,
      reference = excluded.reference,
      recipient_name = excluded.recipient_name,
      recipient_account = excluded.recipient_account,
      recipient_bsb = excluded.recipient_bsb,
      recipient_bank = excluded.recipient_bank,
      swift_code = excluded.swift_code,
      iban = excluded.iban,
      country = excluded.country,
      status = excluded.status,
      fee = excluded.fee,
      exchange_rate = excluded.exchange_rate,
      converted_amount = excluded.converted_amount,
      approved_by = excluded.approved_by,
      approved_at = excluded.approved_at,
      rejection_reason = excluded.rejection_reason
  `).run(payload);

  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
}

async function syncUserToFirestore(user) {
  const firestore = getFirestore();
  if (!firestore || !user || !user.id) {
    return false;
  }

  await firestore.collection(USERS_COLLECTION).doc(String(user.id)).set(toFirestoreUser(user), { merge: true });
  return true;
}

async function syncAccountToFirestore(account) {
  const firestore = getFirestore();
  if (!firestore || !account || !account.id) {
    return false;
  }

  await firestore.collection(ACCOUNTS_COLLECTION).doc(String(account.id)).set(toFirestoreAccount(account), { merge: true });
  return true;
}

async function syncTransactionToFirestore(txn) {
  const firestore = getFirestore();
  if (!firestore || !txn || !txn.id) {
    return false;
  }

  await firestore.collection(TRANSACTIONS_COLLECTION).doc(String(txn.id)).set(toFirestoreTransaction(txn), { merge: true });
  return true;
}

async function syncAllUserTransactionsToFirestore(userId, txnLimit = 1000) {
  const firestore = getFirestore();
  if (!firestore || !userId) {
    return false;
  }

  const transactions = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?'
  ).all(asInt(userId), txnLimit);

  for (const txn of transactions) {
    try {
      await syncTransactionToFirestore(txn);
    } catch (err) {
      console.error(`[firestore-sync] Failed to sync transaction ${txn.id} for user ${userId}:`, err.message);
    }
  }
  return true;
}

async function syncUserBundleToFirestore(userId) {
  const firestore = getFirestore();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!firestore || !user) {
    return false;
  }

  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId);
  const recentTransactions = db.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200'
  ).all(userId);

  const batch = firestore.batch();
  const userDocRef = firestore.collection(USERS_COLLECTION).doc(String(user.id));
  batch.set(userDocRef, toFirestoreUser(user), { merge: true });

  const accountDocRefs = [];
  for (const account of accounts) {
    const accountRef = firestore.collection(ACCOUNTS_COLLECTION).doc(String(account.id));
    accountDocRefs.push(accountRef);
    batch.set(accountRef, toFirestoreAccount(account), { merge: true });
  }

  const txnDocRefs = [];
  for (const txn of recentTransactions) {
    const txnRef = firestore.collection(TRANSACTIONS_COLLECTION).doc(String(txn.id));
    txnDocRefs.push(txnRef);
    batch.set(txnRef, toFirestoreTransaction(txn), { merge: true });
  }

  await batch.commit();

  const verifyPromises = [
    userDocRef.get().then((doc) => {
      if (!doc.exists) {
        throw new Error(`User doc not found in Firestore after sync: users/${user.id}`);
      }
      return doc;
    })
  ];

  for (const accountRef of accountDocRefs) {
    verifyPromises.push(
      accountRef.get().then((doc) => {
        if (!doc.exists) {
          throw new Error(`Account doc not found in Firestore after sync: accounts/${accountRef.id}`);
        }
        return doc;
      })
    );
  }

  await Promise.all(verifyPromises);

  console.log(
    `[firestore-sync] Synced user ${user.id} (${user.email}) ` +
    `+ ${accounts.length} account(s) + ${recentTransactions.length} txn(s) ` +
    `to Firestore project "${getResolvedProjectId()}" ` +
    `-> collection "${USERS_COLLECTION}"`
  );

  return true;
}

async function syncConfiguredAdminToFirestore() {
  const firestore = getFirestore();
  if (!firestore || !ADMIN_DOC_ID) {
    return false;
  }

  const adminUser = db.prepare('SELECT * FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1').get();
  if (!adminUser) {
    return false;
  }

  await syncUserToFirestore(adminUser);
  await firestore.collection(ADMINS_COLLECTION).doc(ADMIN_DOC_ID).set({
    user_id: asInt(adminUser.id),
    user_ref: String(adminUser.id),
    email: (adminUser.email || '').trim().toLowerCase(),
    first_name: adminUser.first_name || '',
    last_name: adminUser.last_name || '',
    phone: adminUser.phone || '',
    role: adminUser.role || 'super_admin',
    active: true,
    is_super_admin: (adminUser.role || 'super_admin') === 'super_admin',
    updated_at: normalizeDateString(adminUser.updated_at) || new Date().toISOString(),
    updated_at_ts: toFirestoreDate(adminUser.updated_at),
    synced_from_server: true
  }, { merge: true });
  return true;
}

async function hydrateUserFromFirestoreByEmail(email) {
  const firestore = getFirestore();
  if (!firestore || !email) {
    return null;
  }

  const snapshot = await firestore.collection(USERS_COLLECTION)
    .where('email', '==', String(email).trim().toLowerCase())
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  const localUser = upsertLocalUser(doc.data(), doc.id);
  const hydrateUserId = localUser ? localUser.id : doc.id;
  await Promise.all([
    hydrateAccountsForUser(hydrateUserId),
    hydrateTransactionsForUser(hydrateUserId)
  ]);
  return localUser;
}

async function firestoreUserExistsByEmail(email) {
  const firestore = getFirestore();
  if (!firestore || !email) {
    return false;
  }

  const snapshot = await firestore.collection(USERS_COLLECTION)
    .where('email', '==', String(email).trim().toLowerCase())
    .limit(1)
    .get();

  return !snapshot.empty;
}

async function hydrateUserFromFirestoreById(userId) {
  const firestore = getFirestore();
  const normalizedUserId = String(userId || '').trim();
  if (!firestore || !normalizedUserId) {
    return null;
  }

  const doc = await firestore.collection(USERS_COLLECTION).doc(normalizedUserId).get();
  if (!doc.exists) {
    return null;
  }

  const localUser = upsertLocalUser(doc.data(), doc.id);
  const hydrateUserId = localUser ? localUser.id : normalizedUserId;
  await Promise.all([
    hydrateAccountsForUser(hydrateUserId),
    hydrateTransactionsForUser(hydrateUserId)
  ]);
  return localUser;
}

async function hydrateAccountsForUser(userId) {
  const firestore = getFirestore();
  const normalizedUserId = asInt(userId);
  if (!firestore || !normalizedUserId) {
    return [];
  }

  const snapshots = await Promise.all([
    firestore.collection(ACCOUNTS_COLLECTION).where('user_id', '==', normalizedUserId).get(),
    firestore.collection(ACCOUNTS_COLLECTION).where('user_ref', '==', String(normalizedUserId)).get()
  ]);

  const seen = new Set();
  const accounts = [];
  for (const snapshot of snapshots) {
    snapshot.docs.forEach((doc) => {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        accounts.push(upsertLocalAccount(doc.data(), doc.id));
      }
    });
  }

  return accounts.filter(Boolean);
}

async function hydrateTransactionsForUser(userId, limit = 500) {
  const firestore = getFirestore();
  const normalizedUserId = asInt(userId);
  if (!firestore || !normalizedUserId) {
    return [];
  }

  const snapshots = await Promise.all([
    firestore.collection(TRANSACTIONS_COLLECTION).where('user_id', '==', normalizedUserId).orderBy('created_at_ts', 'desc').limit(limit).get(),
    firestore.collection(TRANSACTIONS_COLLECTION).where('user_ref', '==', String(normalizedUserId)).orderBy('created_at_ts', 'desc').limit(limit).get()
  ]);

  const seen = new Set();
  const txns = [];
  for (const snapshot of snapshots) {
    snapshot.docs.forEach((doc) => {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        txns.push(upsertLocalTransaction(doc.data(), doc.id));
      }
    });
  }

  return txns.filter(Boolean);
}

async function hydrateRecentCustomersFromFirestore(limit = 200) {
  const firestore = getFirestore();
  if (!firestore) {
    return [];
  }

  const snapshot = await firestore.collection(USERS_COLLECTION)
    .where('is_admin', '==', 0)
    .orderBy('created_at_ts', 'desc')
    .limit(limit)
    .get();

  const users = [];
  for (const doc of snapshot.docs) {
    const localUser = upsertLocalUser(doc.data(), doc.id);
    if (localUser) {
      users.push(localUser);
      await Promise.all([
        hydrateAccountsForUser(localUser.id),
        hydrateTransactionsForUser(localUser.id, 100)
      ]);
    }
  }

  return users;
}

async function getFirestoreDashboardCustomerStats() {
  const firestore = getFirestore();
  if (!firestore) {
    return null;
  }

  const usersRef = firestore.collection(USERS_COLLECTION);
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);

  const [totalSnap, newSnap, unverifiedSnap, recentSnap] = await Promise.all([
    usersRef.where('is_admin', '==', 0).count().get(),
    usersRef.where('is_admin', '==', 0).where('created_at_ts', '>=', weekStart).count().get(),
    usersRef.where('is_admin', '==', 0).where('is_verified', '==', 0).count().get(),
    usersRef.where('is_admin', '==', 0).orderBy('created_at_ts', 'desc').limit(5).get()
  ]);

  const recentUsers = recentSnap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: asInt(data.sql_id || doc.id),
      first_name: data.first_name || '',
      last_name: data.last_name || '',
      email: data.email || '',
      is_verified: asInt(data.is_verified),
      is_frozen: asInt(data.is_frozen),
      created_at: toSqlDateTime(data.created_at || data.created_at_ts) || toSqlDateTime(new Date())
    };
  });

  return {
    totalCustomers: totalSnap.data().count || 0,
    newThisWeek: newSnap.data().count || 0,
    unverifiedCustomers: unverifiedSnap.data().count || 0,
    recentUsers
  };
}

async function backfillLocalUsersToFirestore(limit = 500) {
  const firestore = getFirestore();
  if (!firestore) {
    console.warn('[firestore-sync] backfillLocalUsersToFirestore: Firestore not available, skipping backfill.');
    return { synced: 0, skipped: 0, errors: 0, total: 0 };
  }

  const localUsers = db.prepare(
    'SELECT * FROM users ORDER BY id ASC LIMIT ?'
  ).all(limit);

  const stats = { synced: 0, skipped: 0, errors: 0, total: localUsers.length };
  console.log(`[firestore-sync] Starting backfill of ${localUsers.length} local user(s) to Firestore...`);

  for (const user of localUsers) {
    try {
      const docRef = firestore.collection(USERS_COLLECTION).doc(String(user.id));
      const existing = await docRef.get();
      if (existing.exists) {
        stats.skipped++;
        continue;
      }
      const ok = await syncUserBundleToFirestore(user.id);
      if (ok) {
        stats.synced++;
      } else {
        stats.errors++;
      }
    } catch (err) {
      stats.errors++;
      console.error(`[firestore-sync] Backfill failed for user ${user.id} (${user.email}):`, err.message);
    }
  }

  console.log(
    `[firestore-sync] Backfill complete. Total: ${stats.total}, ` +
    `Synced: ${stats.synced}, Already present: ${stats.skipped}, Errors: ${stats.errors}`
  );
  return stats;
}

module.exports = {
  isFirestoreEnabled,
  syncUserToFirestore,
  syncAccountToFirestore,
  syncTransactionToFirestore,
  syncAllUserTransactionsToFirestore,
  syncUserBundleToFirestore,
  syncConfiguredAdminToFirestore,
  hydrateUserFromFirestoreByEmail,
  hydrateUserFromFirestoreById,
  hydrateAccountsForUser,
  hydrateTransactionsForUser,
  hydrateRecentCustomersFromFirestore,
  firestoreUserExistsByEmail,
  getFirestoreDashboardCustomerStats,
  backfillLocalUsersToFirestore
};
