'use strict';

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

function toMinorUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) {
    throw new TypeError('Enter a valid monetary amount with no more than two decimal places.');
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  const signed = negative ? -minor : minor;
  if (signed > MAX_SAFE_MINOR || signed < -MAX_SAFE_MINOR) throw new RangeError('Amount exceeds the supported range.');
  return Number(signed);
}

function fromMinorUnits(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError('Stored monetary values must be safe integer minor units.');
  return value / 100;
}

function formatMinorUnits(value, currency = 'AUD') {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(fromMinorUnits(value));
}

module.exports = { toMinorUnits, fromMinorUnits, formatMinorUnits };
