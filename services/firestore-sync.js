const { db } = require('../database');
const { getFirestore, hasAdminCredentials } = require('../lib/firebase-admin');

const USERS_COLLECTION = process.env.FIRESTORE_USERS_COLLECTION || 'users';
const ACCOUNTS_COLLECTION = process.env.FIRESTORE_ACCOUNTS_COLLECTION || 'accounts';
const ADMINS_COLLECTION = process.env.FIREBASE_ADMIN_COLLECTION || 'admins';
const ADMIN_DOC_ID = process.env.FIREBASE_ADMIN_DOC_ID || null;

function isFirestoreEnabled() {
  return hasAdminCredentials() && Boolean(getFirestore());
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

async function syncUserBundleToFirestore(userId) {
  const firestore = getFirestore();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!firestore || !user) {
    return false;
  }

  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(userId);

  const batch = firestore.batch();
  batch.set(
    firestore.collection(USERS_COLLECTION).doc(String(user.id)),
    toFirestoreUser(user),
    { merge: true }
  );

  for (const account of accounts) {
    batch.set(
      firestore.collection(ACCOUNTS_COLLECTION).doc(String(account.id)),
      toFirestoreAccount(account),
      { merge: true }
    );
  }

  await batch.commit();

  const [userDoc, accountDoc] = await Promise.all([
    firestore.collection(USERS_COLLECTION).doc(String(user.id)).get(),
    accounts.length
      ? firestore.collection(ACCOUNTS_COLLECTION).doc(String(accounts[0].id)).get()
      : Promise.resolve({ exists: true })
  ]);

  if (!userDoc.exists || !accountDoc.exists) {
    throw new Error('Firestore registration sync verification failed.');
  }

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
  await hydrateAccountsForUser(localUser ? localUser.id : doc.id);
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
  await hydrateAccountsForUser(localUser ? localUser.id : normalizedUserId);
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
      await hydrateAccountsForUser(localUser.id);
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

module.exports = {
  isFirestoreEnabled,
  syncUserToFirestore,
  syncAccountToFirestore,
  syncUserBundleToFirestore,
  syncConfiguredAdminToFirestore,
  hydrateUserFromFirestoreByEmail,
  hydrateUserFromFirestoreById,
  hydrateRecentCustomersFromFirestore,
  firestoreUserExistsByEmail,
  getFirestoreDashboardCustomerStats
};
