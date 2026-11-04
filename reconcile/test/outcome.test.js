'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { decideOutcome, endRun, isRecovery } = require('../lib/outcome');

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

const fakeCore = () => {
  const calls = { failed: [], warning: [], outputs: {} };
  return { calls, setFailed: (m) => calls.failed.push(m), warning: (m) => calls.warning.push(m), setOutput: (k, v) => { calls.outputs[k] = v; } };
};

test('endRun: recovery warns and reports recovery=true, without failing', () => {
  const core = fakeCore();
  endRun(core, 'main already carries every repo change', true);
  assert.deepStrictEqual(core.calls, { failed: [], warning: ['main already carries every repo change'], outputs: { recovery: 'true' } });
});

test('endRun: any other outcome fails and reports no recovery', () => {
  const core = fakeCore();
  endRun(core, 'no committable source change', false);
  assert.deepStrictEqual(core.calls, { failed: ['no committable source change'], warning: [], outputs: {} });
});

// The job's color: the pre-build check no longer fails the job by itself, so every gate after it
// must read its outcome, and only reconcile's recovery output may skip the final failure.
test('action.yml: a failed check stays red unless reconcile reports recovery', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', 'action.yml'), 'utf8');
  const steps = yml.split(/\n    - name: /).slice(1).map((b) => ({ name: b.split('\n')[0], if: (/\n      if: (.*)/.exec(b) || [])[1] || '', body: b }));
  const step = (n) => steps.find((s) => s.name === n);
  assert.match(step('Pre-build Consistency check').body, /\n      continue-on-error: true\n/);
  const fail = steps.findIndex((s) => s.name === 'Fail on drift');
  assert.strictEqual(steps[fail].if, "${{ success() && steps.pre-build-consistency-check.outcome == 'failure' && steps.reconcile.outputs.recovery != 'true' }}");
  assert.match(steps[fail].body, /\n        exit 1\n/);
  assert.match(step('Close a stale reconciliation PR').if, /steps\.pre-build-consistency-check\.outcome == 'success'/);
  for (const n of ['Setup PHP + Composer for reconcile', 'Reconcile drift']) assert.match(step(n).if, /steps\.pre-build-consistency-check\.outcome == 'failure'/);
  // Before the final failure, failure() no longer means "the check failed".
  for (const s of steps.slice(0, fail)) assert.doesNotMatch(s.if, /failure\(\)/, s.name);
  for (const s of steps.slice(fail + 1)) assert.match(s.if, /failure\(\)/, s.name);
});

// A lagging built record is only recovery when nothing is left to decide: an item that still needs
// one (partial / unrecoverable-only) keeps the job red, the Slack alert and the failed webhook.
test('isRecovery: lagging record + an item needing a decision is not recovery', () => {
  assert.strictEqual(isRecovery(true, [rec, unrec]), false);
  assert.strictEqual(isRecovery(true, [unrec]), false);
  assert.strictEqual(isRecovery(true, [rec, { recoverable: false, category: 'deferred' }]), false);
});

test('isRecovery: lagging record with nothing left (ignorable aside) is recovery; no lag is not', () => {
  assert.strictEqual(isRecovery(true, [rec, ign]), true);
  assert.strictEqual(isRecovery(false, [rec]), false);
});

test('index.js: the nothing-staged path decides recovery through isRecovery', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(src, /const recovery = isRecovery\(recording && !crit\.length && !suspicious, classified\);/);
  assert.strictEqual(src.match(/endRun\(core, noCommitFailure\('reconciled', ref, true\), true\)/g).length, 1);
  assert.match(src, /if \(open\) core\.setFailed\(.*\);\n\s*else if \(sha\) endRun\(/);
});

// The final annotation names the PR the run opened or updated, so a red check says where the fix waits.
test('action.yml: "Fail on drift" names the reconciliation PR when there is one', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', 'action.yml'), 'utf8');
  const block = yml.split(/\n    - name: /).find((b) => b.startsWith('Fail on drift\n'));
  assert.match(block, /\n        PR: \$\{\{ steps\.reconcile\.outputs\.pr \}\}\n/);
  assert.match(block, /\n        AUTO_MERGE: \$\{\{ steps\.reconcile\.outputs\.auto-merge \}\}\n/);
  const script = block.split('\n      run: |\n')[1].split('\n').map((l) => l.replace(/^ {8}/, '')).join('\n');
  const run = (env) => {
    try { execFileSync('bash', ['-c', script], { env: { PATH: process.env.PATH, PR_URL: 'https://github.test/o/r/pull/7', ...env }, encoding: 'utf8' }); } catch (e) { return e.stdout.trim(); }
    assert.fail('exits non-zero');
  };
  const base = '::error::The server does not match the deployed build: see the consistency check step above';
  assert.strictEqual(run({ PR: '' }), `${base}.`);
  assert.strictEqual(run({ PR: '7', AUTO_MERGE: 'false' }), `${base}; the repo changes are held in PR #7 for review: https://github.test/o/r/pull/7`);
  assert.strictEqual(run({ PR: '7', AUTO_MERGE: 'true' }), `${base}; the repo changes are in PR #7, merged once a build of it reproduces the server: https://github.test/o/r/pull/7`);
});
