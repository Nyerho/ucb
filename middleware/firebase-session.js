'use strict';

const { getRuntimeEnv } = require('../lib/runtime-env');
let josePromise;
const COOKIE_NAME = 'ucb_session';
const ONE_DAY_SECONDS = 24 * 60 * 60;

async function jose() {
  josePromise ||= import('jose');
  return josePromise;
}

async function encryptionKey() {
  const secret = getRuntimeEnv('SESSION_ENCRYPTION_KEY') || getRuntimeEnv('SESSION_SECRET');
  if (!secret || String(secret).length < 32) {
    throw new Error('SESSION_ENCRYPTION_KEY (or SESSION_SECRET) must be configured with at least 32 characters.');
  }
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  return new Uint8Array(bytes);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); } catch (_) { return null; }
    }
  }
  return null;
}

function safeSessionData(session) {
  const data = { ...session };
  delete data.user;
  delete data.userId;
  return data;
}

module.exports = function firebaseSession(req, res, next) {
  let data = {};
  let dirty = false;
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  const initialize = async () => {
    if (token) {
      try {
        const { jwtDecrypt } = await jose();
        const { payload } = await jwtDecrypt(token, await encryptionKey(), { clockTolerance: 5 });
        data = payload.session && typeof payload.session === 'object' ? payload.session : {};
      } catch (_) {
        data = {};
        dirty = true;
      }
    }

    // Identity and authorization are re-derived from a verified Firebase ID token on each request.
    delete data.user;
    delete data.userId;
    req.session = new Proxy(data, {
      set(target, key, value) {
        dirty = true;
        target[key] = value;
        return true;
      },
      deleteProperty(target, key) {
        dirty = true;
        return Reflect.deleteProperty(target, key);
      }
    });

    const originalEnd = res.end;
    let ending = false;
    res.end = function encryptedSessionEnd(...args) {
      if (!dirty || ending || res.headersSent) return originalEnd.apply(this, args);
      ending = true;
      persistSession(req, res).then(
        () => originalEnd.apply(res, args),
        () => {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.removeHeader('Set-Cookie');
          }
          originalEnd.call(res);
        }
      );
      return this;
    };
    next();
  };

  initialize().catch(next);
};

async function persistSession(req, res) {
  const session = safeSessionData(req.session || {});
  const isEmpty = Object.keys(session).length === 0;
  const secure = process.env.NODE_ENV === 'production' || String(req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https';
  if (isEmpty) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
    return;
  }
  const { EncryptJWT } = await jose();
  const token = await new EncryptJWT({ session })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${ONE_DAY_SECONDS}s`)
    .encrypt(await encryptionKey());
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_DAY_SECONDS}${secure ? '; Secure' : ''}`);
}

module.exports.COOKIE_NAME = COOKIE_NAME;
module.exports.ONE_DAY_SECONDS = ONE_DAY_SECONDS;
