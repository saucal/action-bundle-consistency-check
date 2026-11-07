'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { branchSame } = require('../lib/branch-same');

const MSG = 'Reconcile server drift on main [commit only]\n\nBody.\n';
const PENDING = `${MSG}\nSelf-heal-pending: /plugins/example/\n`;

// Plain layout: FETCH_HEAD and HEAD are both one commit on top of base.
function plain(fetchMsg, headMsg) {
  const revs = { 'FETCH_HEAD^{tree}': 't1', 'HEAD^{tree}': 't1', 'FETCH_HEAD^': 'base' };
  const msgs = { FETCH_HEAD: fetchMsg, HEAD: headMsg };
  return { rev: async (r) => revs[r], msg: async (r) => msgs[r], baseSha: 'base' };
}

// Parity layout: FT (HEAD) merges RM (buildSha = merge(since, R)) with the tip (base).
function parity(fetchRMsg, rMsg) {
  const revs = {
    'FETCH_HEAD^{tree}': 'tF', 'HEAD^{tree}': 'tF', 'FETCH_HEAD^2': 'base',
    'FETCH_HEAD^1^{tree}': 'tR', 'RM^{tree}': 'tR', 'FETCH_HEAD^1^1': 'since', 'FETCH_HEAD^1^2^{tree}': 'tR',
  };
  const msgs = { 'FETCH_HEAD^1': fetchRMsg, RM: rMsg };
  return { rev: async (r) => (r in revs ? revs[r] : `fatal: ${r}`), msg: async (r) => msgs[r], baseSha: 'base', buildSha: 'RM', since: 'since' };
}

test('same tree, base and message: same', async () => {
  assert.strictEqual(await branchSame(plain(MSG, MSG)), true);
});
test('same tree and base, stale Self-heal-pending line: not same', async () => {
  assert.strictEqual(await branchSame(plain(PENDING, MSG)), false);
});
test('different tree: not same', async () => {
  const o = plain(MSG, MSG);
  const rev = o.rev;
  o.rev = async (r) => (r === 'HEAD^{tree}' ? 't2' : rev(r));
  assert.strictEqual(await branchSame(o), false);
});
test('parity layout, same R message: same', async () => {
  assert.strictEqual(await branchSame(parity(PENDING, PENDING)), true);
});
test('parity layout, different R message: not same', async () => {
  assert.strictEqual(await branchSame(parity(PENDING, MSG)), false);
});
test('older layout (F on R, no RM): not same, so the branch is rebuilt as RM + FT', async () => {
  const o = parity(PENDING, PENDING);
  const rev = o.rev;
  o.rev = async (r) => (r === 'FETCH_HEAD^1^2^{tree}' ? 'fatal: bad revision' : rev(r));
  assert.strictEqual(await branchSame(o), false);
});
test('RM layout (the head is the heal itself): same heal = same, whatever the tip', async () => {
  const revs = { 'FETCH_HEAD^{tree}': 'tR', 'HEAD^{tree}': 'tR', 'RM^{tree}': 'tR', 'FETCH_HEAD^1': 'since', 'FETCH_HEAD^2^{tree}': 'tR' };
  const o = (fetchMsg) => ({ rev: async (r) => (r in revs ? revs[r] : `fatal: ${r}`), msg: async (r) => ({ FETCH_HEAD: fetchMsg, RM: PENDING })[r],
    baseSha: 'moved-tip', buildSha: 'RM', since: 'since', layout: 'RM' });
  assert.strictEqual(await branchSame(o(PENDING)), true);
  assert.strictEqual(await branchSame(o(MSG)), false);
});
