const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toMinorUnits, readMinorUnits, fromMinorUnits } = require('../services/money');

test('legacy decimal dollars convert exactly to integer minor units', () => {
  assert.equal(readMinorUnits({ balance: 1250.75 }, 'balance_minor', 'balance'), 125075);
  assert.equal(readMinorUnits({ amount: '-12.30' }, 'amount_minor', 'amount'), -1230);
  assert.equal(readMinorUnits({ balance: 0 }, 'balance_minor', 'balance'), 0);
});

test('minor-unit field is authoritative when both legacy and normalized fields exist', () => {
  assert.equal(readMinorUnits({ balance_minor: 12345, balance: 100.00 }, 'balance_minor', 'balance'), 12345);
});

test('invalid explicit minor-unit fields fail closed instead of falling back to stale dollars', () => {
  assert.throws(
    () => readMinorUnits({ balance_minor: 12.5, balance: 12.50 }, 'balance_minor', 'balance'),
    /safe integer in minor units/
  );
  assert.throws(
    () => readMinorUnits({ balance_minor: '1250', balance: 12.50 }, 'balance_minor', 'balance'),
    /safe integer in minor units/
  );
});

test('legacy values with sub-cent precision are rejected', () => {
  assert.throws(() => readMinorUnits({ balance: 1.001 }, 'balance_minor', 'balance'), /no more than two decimal places/);
});

test('missing values use the caller-provided default and standard conversion remains strict', () => {
  assert.equal(readMinorUnits({}, 'balance_minor', 'balance'), 0);
  assert.equal(readMinorUnits({}, 'available_balance_minor', 'available_balance', 500), 500);
  assert.equal(toMinorUnits('10.05'), 1005);
  assert.equal(fromMinorUnits(1005), 10.05);
});
