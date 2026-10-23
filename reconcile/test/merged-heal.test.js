'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { findMergedHeal, pendingOf } = require('../lib/merged-heal');

test('finds the newest heal for the ref, ignoring other refs and plain commits', () => {
  const log = [
    'aaa\tDeploy via action-maintenance v3 [skip deploy]',
    'bbb\tReconcile server drift on develop [commit only]',
    'ccc\tReconcile server drift on main [commit only]',
    'ddd\tReconcile server drift on main [commit only]',
    'eee\tsome feature',
  ].join('\n');
  assert.strictEqual(findMergedHeal(log, 'main'), 'ccc');
  assert.strictEqual(findMergedHeal(log, 'develop'), 'bbb');
});

test('accepts a squash subject; none found -> empty', () => {
  assert.strictEqual(findMergedHeal('fff\tReconcile server drift on main [commit only] (#95)', 'main'), 'fff');
  assert.strictEqual(findMergedHeal('ggg\tReconcile server drift on main\nhhh\tfix', 'main'), '');
  assert.strictEqual(findMergedHeal('', 'main'), '');
});

test('reads the Self-heal-pending paths of a commit message', () => {
  const msg = 'Reconcile server drift on main [commit only]\n\nParity…\n\nSelf-heal-pending: /w3tc-config/master.php\nSelf-heal-pending: /plugins/payoneer-checkout/\n';
  assert.strictEqual(pendingOf(msg), '/w3tc-config/master.php\n/plugins/payoneer-checkout/');
  assert.strictEqual(pendingOf('no lines'), '');
});
