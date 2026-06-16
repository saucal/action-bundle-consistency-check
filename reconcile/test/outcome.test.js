'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { decideOutcome } = require('../lib/outcome');

const rec = { recoverable: true, category: 'wpackagist-plugin' };
const unrec = { recoverable: false, category: 'compiled-asset' };
const ign = { recoverable: false, category: 'ignorable' };

test('reconciled when only recoverable', () => {
  assert.strictEqual(decideOutcome([rec, rec]), 'reconciled');
});
test('partial when recoverable + unrecoverable', () => {
  assert.strictEqual(decideOutcome([rec, unrec]), 'partial');
});
test('unrecoverable-only', () => {
  assert.strictEqual(decideOutcome([unrec]), 'unrecoverable-only');
});
test('ignorable-only', () => {
  assert.strictEqual(decideOutcome([ign, ign]), 'ignorable-only');
});
test('noop when empty', () => {
  assert.strictEqual(decideOutcome([]), 'noop');
});

test('patched-candidate counts as recoverable -> reconciled', () => {
  assert.strictEqual(decideOutcome([{ recoverable: true, category: 'patched-candidate' }]), 'reconciled');
});
