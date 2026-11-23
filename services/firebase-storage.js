'use strict';

const { getRuntimeEnv } = require('../lib/runtime-env');
const { getServiceAccessToken } = require('./firestore-rest');
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const TOKEN_HEADER = 'authorization';

function bucketName() {
  const value = getRuntimeEnv('FIREBASE_STORAGE_BUCKET');
  if (!value) throw new Error('Missing required runtime binding: FIREBASE_STORAGE_BUCKET');
  return String(value).replace(/^gs:\/\//, '');
}

function validateObjectName(name) {
  const value = String(name || '');
  if (!value || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Invalid private Storage object name.');
  }
  return value;
}

async function storageRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      [TOKEN_HEADER]: `Bearer ${await getServiceAccessToken(STORAGE_SCOPE)}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    const error = new Error(`Private Firebase Storage request failed (${status}).`);
    error.status = status;
    throw error;
  }
  return response;
}

async function uploadObject(name, bytes, contentType) {
  const objectName = validateObjectName(name);
  const bucket = bucketName();
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set('name', objectName);
  url.searchParams.set('fields', 'name,size,contentType,md5Hash');
  const response = await storageRequest(url, {
    method: 'POST',
    headers: { 'content-type': contentType || 'application/octet-stream' },
    body: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  });
  const metadata = await response.json();
  return {
    name: metadata.name,
    size: Number(metadata.size || bytes.byteLength || bytes.length),
    contentType: metadata.contentType || contentType || 'application/octet-stream',
    md5Hash: metadata.md5Hash || null
  };
}

async function downloadObject(name) {
  const objectName = validateObjectName(name);
  const bucket = bucketName();
  const url = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`);
  url.searchParams.set('alt', 'media');
  const response = await storageRequest(url);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/octet-stream'
  };
}

async function deleteObject(name) {
  const objectName = validateObjectName(name);
  const bucket = bucketName();
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`;
  const response = await storageRequest(url, { method: 'DELETE' });
  await response.body?.cancel().catch(() => {});
  return true;
}

module.exports = { uploadObject, downloadObject, deleteObject, validateObjectName };
