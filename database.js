const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'database.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT NOT NULL,
    password TEXT NOT NULL,
    address TEXT,
    city TEXT,
    state TEXT,
    postcode TEXT,
    country TEXT DEFAULT 'Australia',
    date_of_birth DATE,
    profile_image TEXT,
    is_admin INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    is_frozen INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_number TEXT UNIQUE NOT NULL,
    account_type TEXT NOT NULL,
    account_name TEXT NOT NULL,
    currency TEXT DEFAULT 'AUD',
    balance DECIMAL(15,2) DEFAULT 0.00,
    available_balance DECIMAL(15,2) DEFAULT 0.00,
    interest_rate DECIMAL(5,4) DEFAULT 0.00,
    status TEXT DEFAULT 'active',
    branch TEXT DEFAULT 'Sydney CBD',
    bsb TEXT DEFAULT '082-987',
    opened_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    transaction_type TEXT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency TEXT DEFAULT 'AUD',
    description TEXT,
    reference TEXT,
    recipient_name TEXT,
    recipient_account TEXT,
    recipient_bsb TEXT,
    recipient_bank TEXT,
    swift_code TEXT,
    iban TEXT,
    country TEXT,
    status TEXT DEFAULT 'pending',
    fee DECIMAL(15,2) DEFAULT 0.00,
    exchange_rate DECIMAL(10,6),
    converted_amount DECIMAL(15,2),
    approved_by INTEGER,
    approved_at DATETIME,
    rejection_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    card_type TEXT NOT NULL,
    card_number TEXT UNIQUE NOT NULL,
    cardholder_name TEXT NOT NULL,
    expiry_date TEXT NOT NULL,
    cvv TEXT NOT NULL,
    pin TEXT,
    daily_limit DECIMAL(15,2) DEFAULT 2000.00,
    credit_limit DECIMAL(15,2) DEFAULT 0.00,
    available_credit DECIMAL(15,2) DEFAULT 0.00,
    status TEXT DEFAULT 'pending',
    delivery_address TEXT,
    approved_by INTEGER,
    approved_at DATETIME,
    rejection_reason TEXT,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS loans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER,
    loan_type TEXT NOT NULL,
    loan_amount DECIMAL(15,2) NOT NULL,
    interest_rate DECIMAL(5,4) NOT NULL,
    loan_term_months INTEGER NOT NULL,
    monthly_repayment DECIMAL(15,2),
    total_repayment DECIMAL(15,2),
    purpose TEXT,
    employment_status TEXT,
    annual_income DECIMAL(15,2),
    credit_score INTEGER,
    collateral TEXT,
    status TEXT DEFAULT 'pending',
    approved_by INTEGER,
    approved_at DATETIME,
    rejection_reason TEXT,
    disbursed_at DATETIME,
    next_payment_date DATE,
    remaining_balance DECIMAL(15,2),
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS loan_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id INTEGER NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    principal_amount DECIMAL(15,2),
    interest_amount DECIMAL(15,2),
    payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    payment_method TEXT,
    status TEXT DEFAULT 'completed',
    FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kyc (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    document_type TEXT NOT NULL,
    document_number TEXT NOT NULL,
    document_front TEXT,
    document_back TEXT,
    document_selfie TEXT,
    id_expiry DATE,
    status TEXT DEFAULT 'pending',
    reviewed_by INTEGER,
    reviewed_at DATETIME,
    rejection_reason TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS bill_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    account_id INTEGER NOT NULL,
    biller_name TEXT NOT NULL,
    biller_code TEXT,
    reference_number TEXT NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    currency TEXT DEFAULT 'AUD',
    payment_date DATE,
    recurring INTEGER DEFAULT 0,
    frequency TEXT,
    status TEXT DEFAULT 'pending',
    approved_by INTEGER,
    approved_at DATETIME,
    rejection_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS beneficiaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    account_number TEXT NOT NULL,
    bsb TEXT,
    bank_name TEXT,
    swift_code TEXT,
    iban TEXT,
    country TEXT,
    is_international INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id INTEGER,
    details TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

function ensureColumn(tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(column => column.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn('users', 'transfer_pin_hash', 'TEXT');
ensureColumn('users', 'transfer_pin_updated_at', 'DATETIME');

function generateAccountNumber() {
  return '200' + Math.random().toString().slice(2, 10);
}

function generateCardNumber() {
  const prefix = '4539';
  let num = prefix;
  for (let i = 0; i < 11; i++) {
    num += Math.floor(Math.random() * 10);
  }
  return num;
}

function generateCVV() {
  return String(Math.floor(100 + Math.random() * 900));
}

const adminCheck = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 1');
if (adminCheck.get().count === 0) {
  const insertAdmin = db.prepare(`
    INSERT INTO users (first_name, last_name, email, phone, password, address, city, state, postcode, country, date_of_birth, is_admin, is_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `);
  const adminHash = bcrypt.hashSync('Admin@2026', 10);
  const adminResult = insertAdmin.run(
    'System',
    'Administrator',
    'admin@unitedcreditbank.com.au',
    '02-8000-0001',
    adminHash,
    '1 Martin Place',
    'Sydney',
    'NSW',
    '2000',
    'Australia',
    '1980-01-01'
  );

  const adminAccount = db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, account_name, balance, available_balance, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  adminAccount.run(
    adminResult.lastInsertRowid,
    generateAccountNumber(),
    'Admin Account',
    'System Admin',
    9999999.99,
    9999999.99,
    'active'
  );
}

const sampleUserCheck = db.prepare('SELECT COUNT(*) as count FROM users WHERE is_admin = 0');
if (sampleUserCheck.get().count === 0) {
  const insertUser = db.prepare(`
    INSERT INTO users (first_name, last_name, email, phone, password, address, city, state, postcode, country, date_of_birth, is_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const userHash = bcrypt.hashSync('Customer@2026', 10);
  const userResult = insertUser.run(
    'John',
    'Smith',
    'john.smith@email.com.au',
    '0412-345-678',
    userHash,
    '123 Bondi Road',
    'Sydney',
    'NSW',
    '2026',
    'Australia',
    '1990-05-15'
  );

  const insertAccount = db.prepare(`
    INSERT INTO accounts (user_id, account_number, account_type, account_name, balance, available_balance, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertAccount.run(
    userResult.lastInsertRowid,
    generateAccountNumber(),
    'Everyday Savings',
    'John Smith',
    25000.50,
    25000.50,
    'active'
  );
}

module.exports = {
  db,
  generateAccountNumber,
  generateCardNumber,
  generateCVV
};
