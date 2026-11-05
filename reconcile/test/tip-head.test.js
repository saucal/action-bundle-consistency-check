'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { tipHead, materializeTip, healOf, isAncestor } = require('../lib/tip-head');
const { tipPrVerdict, recoverable, joinedComment, recoveredNote } = require('../lib/undeployed-pr');

// A scratch repo built with the same commit-tree calls index.js makes.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tip-head-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const g = (...a) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  const git = async (...a) => { const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
  g('init', '-q', '-b', 'main');
  // commit <parent> <message> {file: content}: a commit on top of parent with those files changed
  const commit = (parent, message, files) => {
    g('checkout', '-q', '--detach', parent);
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
    g('add', '-A'); g('commit', '-q', '-m', message);
    return g('rev-parse', 'HEAD');
  };
  const tree = (r) => g('rev-parse', `${r}^{tree}`);
  const mergeOf = (tr, parents, m) => g('commit-tree', tr, ...parents.flatMap((p) => ['-p', p]), '-m', m);
  fs.writeFileSync(path.join(dir, 'composer.lock'), 'a 1\nb 1\n');
  fs.writeFileSync(path.join(dir, 'app.php'), 'app\n');
  g('add', '-A'); g('commit', '-q', '-m', 'D deployed');
  return { dir, g, git, commit, tree, mergeOf, D: g('rev-parse', 'HEAD') };
}

// R = heal on D, RM = merge(D, R) with R's tree (index.js).
const heal = (r, on, files) => {
  const R = r.commit(on, 'Reconcile server drift on main [commit only]', files);
  return r.mergeOf(r.tree(R), [on, R], 'Reconcile server drift on main [commit only]\n\nReconciled on top of the last recorded commit.');
};

test('decision 1: RM and U merge cleanly into the heal on the tip: the head is RM itself', async () => {
  const r = repo();
  const U = r.commit(r.D, 'U undeployed', { 'app.php': 'app v2\n' });
  const RM = heal(r, r.D, { 'composer.lock': 'a 2\nb 1\n' });
  const A = r.commit(U, 'run A: heal on the tip', { 'composer.lock': 'a 2\nb 1\n' }); // what reconcile makes on U
  const t = await tipHead({ git: r.git, base: U, rm: RM, tipTree: r.tree(A), message: 'FT' });
  assert.deepStrictEqual(t, { head: RM, layout: 'RM' });
  // GitHub's merge button: merge(U, RM) has the heal on the tip as its tree.
  assert.strictEqual(r.g('merge-tree', '--write-tree', U, RM), r.tree(A));
});

test('decision 1: a conflict (composer.lock) gets the resolving merge FT = merge(RM, U) with run A\'s tree', async () => {
  const r = repo();
  const U = r.commit(r.D, 'U undeployed', { 'composer.lock': 'a 1\nb 3\n' });
  const RM = heal(r, r.D, { 'composer.lock': 'a 2\nb 1\n' });
  const A = r.commit(U, 'run A', { 'composer.lock': 'a 2\nb 3\n' });
  const t = await tipHead({ git: r.git, base: U, rm: RM, tipTree: r.tree(A), message: 'FT' });
  assert.strictEqual(t.layout, 'FT');
  assert.strictEqual(r.g('rev-parse', `${t.head}^1`), RM);
  assert.strictEqual(r.g('rev-parse', `${t.head}^2`), U);
  assert.strictEqual(r.tree(t.head), r.tree(A));
});

test('decision 1: a clean merge that differs from run A (e.g. U bumped the plugin the heal patches) is FT too', async () => {
  const r = repo();
  const U = r.commit(r.D, 'U bumps b', { 'composer.lock': 'a 1\nb 2\n' });
  const RM = heal(r, r.D, { 'app.php': 'app patched\n' });
  // run A: the item is superseded on the tip, so the heal on the tip is U's own tree
  const t = await tipHead({ git: r.git, base: U, rm: RM, tipTree: r.tree(U), message: 'FT' });
  assert.notStrictEqual(r.g('merge-tree', '--write-tree', U, RM), r.tree(U), 'git merges them cleanly, but differently');
  assert.strictEqual(t.layout, 'FT');
  assert.strictEqual(r.tree(t.head), r.tree(U));
});

test('decision 3: drift joins an RM head in place: RM2 = merge(RM, R2) becomes the head, a fast-forward', async () => {
  const r = repo();
  const U = r.commit(r.D, 'U', { 'app.php': 'app v2\n' });
  const RM = heal(r, r.D, { 'composer.lock': 'a 2\nb 1\n' });
  const T = await materializeTip(r.git, U, RM, 'local merge');
  assert.ok(T && await isAncestor(r.git, RM, T) && await isAncestor(r.git, U, T));
  const RM2 = heal(r, RM, { 'composer.lock': 'a 2\nb 2\n' }); // built on the record RM
  const A2 = r.commit(T, 'run A2', { 'composer.lock': 'a 2\nb 2\n' });
  const t = await tipHead({ git: r.git, base: U, rm: RM2, tipTree: r.tree(A2), prev: RM, message: 'FT2' });
  assert.deepStrictEqual(t, { head: RM2, layout: 'RM' });
  assert.ok(await isAncestor(r.git, RM, t.head), 'the old head stays an ancestor: no force push');
  assert.strictEqual(r.g('merge-tree', '--write-tree', U, RM2), r.tree(A2));
});

test('decision 3: drift joins an FT head in place: FT2 = merge(RM2, FT), plus U when it moved', async () => {
  const r = repo();
  const U = r.commit(r.D, 'U', { 'composer.lock': 'a 1\nb 3\n' });
  const RM = heal(r, r.D, { 'composer.lock': 'a 2\nb 1\n' });
  const A = r.commit(U, 'run A', { 'composer.lock': 'a 2\nb 3\n' });
  const FT = (await tipHead({ git: r.git, base: U, rm: RM, tipTree: r.tree(A), message: 'FT' })).head;
  // same U
  let T = await materializeTip(r.git, U, FT, 'local merge');
  const RM2 = heal(r, RM, { 'app.php': 'app hotfix\n' });
  let A2 = r.commit(T, 'run A2', { 'app.php': 'app hotfix\n' });
  let t = await tipHead({ git: r.git, base: U, rm: RM2, tipTree: r.tree(A2), prev: FT, message: 'FT2' });
  assert.strictEqual(t.layout, 'FT');
  assert.deepStrictEqual(r.g('log', '-1', '--format=%P', t.head).split(' '), [RM2, FT]);
  assert.strictEqual(r.tree(t.head), r.tree(A2));
  // U moved on: the engineers' new commit is a parent too
  const U2 = r.commit(U, 'U2', { 'notes.md': 'more work\n' });
  T = await materializeTip(r.git, U2, FT, 'local merge');
  A2 = r.commit(T, 'run A2', { 'app.php': 'app hotfix\n' });
  t = await tipHead({ git: r.git, base: U2, rm: RM2, tipTree: r.tree(A2), prev: FT, message: 'FT2' });
  assert.deepStrictEqual(r.g('log', '-1', '--format=%P', t.head).split(' '), [RM2, FT, U2]);
  assert.ok(await isAncestor(r.git, FT, t.head));
});

test('decision 3: a tip that no longer merges with the PR head is refused (null)', async () => {
  const r = repo();
  const RM = heal(r, r.D, { 'composer.lock': 'a 2\nb 1\n' });
  const U = r.commit(r.D, 'U', { 'composer.lock': 'a 9\nb 1\n' });
  assert.strictEqual(await materializeTip(r.git, U, RM, 'local merge'), null);
});

test('healOf: an RM head is its own heal; an FT head carries its 1st parent', () => {
  assert.strictEqual(healOf('rm', 'Reconcile server drift on main [commit only]', 'd'), 'rm');
  assert.strictEqual(healOf('ft', "Merge main's 1 undeployed commit(s) on top of the self-heal", 'rm'), 'rm');
});

test('the open engineers\' PR: kept while it carries the record, closed when stale or never recorded', () => {
  const pr = { rm: 'rm2' };
  assert.strictEqual(tipPrVerdict(pr, 'rm2', { inHead: true, inRef: false }), 'keep');
  assert.strictEqual(tipPrVerdict(pr, 'rm1', { inHead: true, inRef: false }), 'keep'); // RM2 joined, verify pending: RM1 still carried
  assert.strictEqual(tipPrVerdict(pr, 'x', { inHead: false, inRef: true }), 'stale'); // a forced Deploy
  assert.strictEqual(tipPrVerdict(pr, 'd', { inHead: true, inRef: true }), 'unrecorded'); // its verify failed
  assert.strictEqual(tipPrVerdict(pr, '', { inHead: false, inRef: false }), 'keep');
  // the API could not answer: never close (that deletes the branch keeping RM and R reachable)
  assert.strictEqual(tipPrVerdict(pr, 'x', { inHead: null, inRef: true }), 'keep');
  assert.strictEqual(tipPrVerdict(pr, 'd', { inHead: true, inRef: null }), 'keep');
});

test('decision 2: a closed engineers\' PR is recovered only when unmerged, its heal is the record and {ref} lacks it', () => {
  const closed = { number: '7', rm: 'rm', merged: false };
  assert.strictEqual(recoverable(closed, 'rm', false), true);
  assert.strictEqual(recoverable({ ...closed, merged: true }, 'rm', false), false);
  assert.strictEqual(recoverable(closed, 'other', false), false); // closed as stale by the self-heal
  assert.strictEqual(recoverable(closed, 'rm', true), false); // its heal reached {ref} another way
  assert.strictEqual(recoverable(null, 'rm', false), false);
  assert.strictEqual(recoverable(closed, 'rm', null), false); // the API could not answer
  const note = recoveredNote('main', '7', 'a'.repeat(40));
  assert.match(note, /Replaces #7, closed without merging/);
  assert.match(note, /never reopened/);
});

test('decision 3: the trace comment names what joined and where the head moved', () => {
  const c = joinedComment({ items: ['akismet'] }, { items: ['akismet', 'hello.php'] }, { prior: 'a'.repeat(40), rm: 'b'.repeat(40), from: 'c'.repeat(40), to: 'd'.repeat(40), runUrl: 'u' });
  assert.match(c, /Joined: `hello\.php`/);
  assert.doesNotMatch(c, /Joined: .*akismet/);
  assert.match(c, /`ccccccc` → `ddddddd` \(commits added on top, no force push\)/);
});
