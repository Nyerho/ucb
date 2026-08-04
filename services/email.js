const nodemailer = require('nodemailer');
const { db } = require('../database');

const OUTGOING_TYPES = new Set(['local_transfer', 'international_transfer', 'withdrawal', 'bill_payment', 'loan_payment']);
const INCOMING_TYPES = new Set(['deposit', 'loan_disbursement']);

let cachedTransporter = null;

function getEmailConfig() {
  const host = process.env.BREVO_SMTP_HOST || process.env.SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.BREVO_SMTP_PORT || process.env.SMTP_PORT || 587);
  const user = process.env.BREVO_SMTP_LOGIN || process.env.BREVO_SMTP_USER || process.env.SMTP_USER || process.env.BREVO_LOGIN || '';
  const pass = process.env.BREVO_SMTP_PASSWORD || process.env.BREVO_API_KEY || process.env.SMTP_PASS || process.env.BREVO_KEY || '';
  const from = process.env.EMAIL_FROM || process.env.BREVO_FROM_EMAIL || process.env.SMTP_FROM || 'United Credit Bank <no-reply@unitedcreditbank.xyz>';
  const replyTo = process.env.EMAIL_REPLY_TO || process.env.BREVO_REPLY_TO || process.env.SMTP_REPLY_TO || undefined;
  return { host, port, user, pass, from, replyTo };
}

function isEmailConfigured() {
  const cfg = getEmailConfig();
  return Boolean(cfg.user && cfg.pass && cfg.from);
}

function getTransporter() {
  if (!isEmailConfigured()) {
    return null;
  }
  if (!cachedTransporter) {
    const cfg = getEmailConfig();
    cachedTransporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: {
        user: cfg.user,
        pass: cfg.pass
      }
    });
  }
  return cachedTransporter;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCurrency(amount, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency
  }).format(Number(amount || 0));
}

function getAppBaseUrl(req) {
  const forwardedProto = req && typeof req.get === 'function'
    ? String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase()
    : '';
  const host = req && typeof req.get === 'function'
    ? String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim()
    : '';
  const protocol = req && host
    ? ((req.secure || forwardedProto === 'https') ? 'https' : 'http')
    : '';

  if (host && protocol) {
    return `${protocol}://${host}`.replace(/\/+$/, '');
  }

  const explicit = process.env.APP_BASE_URL || process.env.PUBLIC_BASE_URL || process.env.SITE_URL;
  if (explicit) {
    return String(explicit).replace(/\/+$/, '');
  }

  const productionUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (productionUrl) {
    const host = String(productionUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${host}`;
  }

  return 'http://localhost:3000';
}

async function sendEmail({ to, subject, html, text }) {
  const transporter = getTransporter();
  if (!transporter || !to) {
    return { sent: false, skipped: true };
  }

  const cfg = getEmailConfig();
  await transporter.sendMail({
    from: cfg.from,
    replyTo: cfg.replyTo,
    to,
    subject,
    html,
    text
  });

  return { sent: true };
}

function buildEmailFrame(title, bodyHtml) {
  return `
    <div style="font-family:Inter,Arial,sans-serif;background:#f8fafc;padding:32px;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;">
        <div style="background:#c8102e;color:#ffffff;padding:24px 28px;">
          <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">United Credit Bank</div>
          <h1 style="margin:8px 0 0;font-size:24px;line-height:1.2;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:28px;">
          ${bodyHtml}
          <p style="margin:24px 0 0;color:#475569;font-size:14px;line-height:1.6;">
            If you need help, reply to this email or use the live chat on the website.
          </p>
        </div>
      </div>
    </div>
  `;
}

function getEffectLabel(txn) {
  if (!txn) {
    return 'Transaction';
  }

  if (txn.transaction_type === 'admin_adjustment') {
    return Number(txn.amount) >= 0 ? 'Credit' : 'Debit';
  }

  if (OUTGOING_TYPES.has(txn.transaction_type)) {
    return 'Debit';
  }

  if (INCOMING_TYPES.has(txn.transaction_type)) {
    return 'Credit';
  }

  return 'Transaction';
}

function getTransactionStatusLine(txn) {
  const status = String(txn.status || 'pending').toLowerCase();
  if (status === 'completed') return 'completed';
  if (status === 'pending') return 'pending approval';
  if (status === 'rejected') return 'rejected';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

async function sendLoginWelcomeEmail(user, meta = {}) {
  if (!user || !user.email) {
    return { sent: false, skipped: true };
  }

  const title = 'Welcome back to United Credit Bank';
  const body = `
    <p style="margin:0 0 16px;font-size:15px;">Hello ${escapeHtml(user.first_name || 'there')},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">
      We noticed a successful login to your online banking account.
    </p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
      <div style="font-size:14px;margin-bottom:6px;"><strong>Email:</strong> ${escapeHtml(user.email)}</div>
      <div style="font-size:14px;margin-bottom:6px;"><strong>Time:</strong> ${escapeHtml(new Date().toISOString())}</div>
      <div style="font-size:14px;margin-bottom:6px;"><strong>IP:</strong> ${escapeHtml(meta.ip || 'Unavailable')}</div>
      <div style="font-size:14px;"><strong>Device:</strong> ${escapeHtml(meta.userAgent || 'Unavailable')}</div>
    </div>
    <p style="margin:16px 0 0;font-size:14px;color:#475569;">
      If this was not you, reset your password immediately and contact support.
    </p>
  `;

  return sendEmail({
    to: user.email,
    subject: 'Successful login to your United Credit Bank account',
    html: buildEmailFrame(title, body),
    text: `Hello ${user.first_name || ''}, a successful login was detected on your account at ${new Date().toISOString()}.`
  });
}

async function sendPasswordResetEmail(user, resetUrl) {
  if (!user || !user.email || !resetUrl) {
    return { sent: false, skipped: true };
  }

  const title = 'Reset your password';
  const safeUrl = escapeHtml(resetUrl);
  const body = `
    <p style="margin:0 0 16px;font-size:15px;">Hello ${escapeHtml(user.first_name || 'there')},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">
      Click the button below to reset your password. This link expires in 30 minutes.
    </p>
    <p style="margin:24px 0;">
      <a href="${safeUrl}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600;">Reset Password</a>
    </p>
    <p style="margin:0;font-size:14px;color:#475569;line-height:1.7;">
      If the button does not work, copy and paste this link into your browser:<br>
      <span style="word-break:break-all;">${safeUrl}</span>
    </p>
  `;

  return sendEmail({
    to: user.email,
    subject: 'Password reset instructions',
    html: buildEmailFrame(title, body),
    text: `Reset your password using this link: ${resetUrl}`
  });
}

async function sendPasswordChangedEmail(user) {
  if (!user || !user.email) {
    return { sent: false, skipped: true };
  }

  const body = `
    <p style="margin:0 0 16px;font-size:15px;">Hello ${escapeHtml(user.first_name || 'there')},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">
      Your password was changed successfully. You can now sign in with your new password.
    </p>
    <p style="margin:0;font-size:14px;color:#475569;">
      If you did not make this change, contact support immediately.
    </p>
  `;

  return sendEmail({
    to: user.email,
    subject: 'Your password has been changed',
    html: buildEmailFrame('Password changed', body),
    text: 'Your United Credit Bank password has been changed successfully.'
  });
}

async function sendTransactionActivityEmailById(txnId, options = {}) {
  if (!txnId) {
    return { sent: false, skipped: true };
  }

  const txn = db.prepare(`
    SELECT
      t.*,
      u.first_name,
      u.last_name,
      u.email,
      a.account_name,
      a.account_number
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    JOIN accounts a ON a.id = t.account_id
    WHERE t.id = ?
  `).get(txnId);

  if (!txn || !txn.email) {
    return { sent: false, skipped: true };
  }

  const effectLabel = getEffectLabel(txn);
  const amountAbs = Math.abs(Number(txn.amount || 0));
  const statusLine = getTransactionStatusLine(txn);
  const accountSuffix = String(txn.account_number || '').slice(-4);
  const description = txn.description || txn.reference || txn.transaction_type;
  const title = `${effectLabel} alert`;
  const body = `
    <p style="margin:0 0 16px;font-size:15px;">Hello ${escapeHtml(txn.first_name || 'there')},</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;">
      A ${escapeHtml(txn.transaction_type.replace(/_/g, ' '))} has been ${escapeHtml(statusLine)} on your account.
    </p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
      <div style="font-size:14px;margin-bottom:6px;"><strong>Type:</strong> ${escapeHtml(effectLabel)}</div>
      <div style="font-size:14px;margin-bottom:6px;"><strong>Amount:</strong> ${escapeHtml(formatCurrency(amountAbs, txn.currency || 'AUD'))}</div>
      <div style="font-size:14px;margin-bottom:6px;"><strong>Status:</strong> ${escapeHtml(statusLine)}</div>
      <div style="font-size:14px;margin-bottom:6px;"><strong>Account:</strong> ${escapeHtml(txn.account_name || 'Account')} ending ${escapeHtml(accountSuffix)}</div>
      <div style="font-size:14px;margin-bottom:6px;"><strong>Description:</strong> ${escapeHtml(description)}</div>
      ${txn.reference ? `<div style="font-size:14px;margin-bottom:6px;"><strong>Reference:</strong> ${escapeHtml(txn.reference)}</div>` : ''}
      ${txn.recipient_name ? `<div style="font-size:14px;"><strong>Recipient:</strong> ${escapeHtml(txn.recipient_name)}</div>` : ''}
    </div>
    ${options.note ? `<p style="margin:16px 0 0;font-size:14px;color:#475569;">${escapeHtml(options.note)}</p>` : ''}
  `;

  return sendEmail({
    to: txn.email,
    subject: `${effectLabel} alert: ${formatCurrency(amountAbs, txn.currency || 'AUD')} ${statusLine}`,
    html: buildEmailFrame(title, body),
    text: `${effectLabel} alert: ${formatCurrency(amountAbs, txn.currency || 'AUD')} ${statusLine}. ${description}`
  });
}

module.exports = {
  getAppBaseUrl,
  isEmailConfigured,
  sendEmail,
  sendLoginWelcomeEmail,
  sendPasswordResetEmail,
  sendPasswordChangedEmail,
  sendTransactionActivityEmailById
};
