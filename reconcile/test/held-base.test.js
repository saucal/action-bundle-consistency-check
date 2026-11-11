'use strict';
// G65 (owner, 2026-11-10): a held heal while commits are undeployed is two PRs. PR 1 reviews the heal r1
// alone, into selfheal-base-<ref> at the deployed commit D; its merge m1 = merge(D, r1) is recorded and the
// engineers' PR (head m1, or FT on a conflict) follows, as on the unattended path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { baseBranchOf, reviewedMerge, tipNote } = require('../lib/undeployed-pr');
const { healOf, isHealSubject, tipHead } = require('../lib/tip-head');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

test('PR 1 merges into a temporary selfheal-base-<ref>, never a selfheal-undeployed-/reconciliation- name', () => {
  assert.strictEqual(baseBranchOf('main'), 'selfheal-base-main');
});

test('reviewedMerge: only PR 1\'s own 2-parent merge on D, whose tree is the heal built on D again', () => {
  const o = { parents: ['d', 'r1'], prHead: 'r1', since: 'd', tree: 't', healTree: 't' };
  assert.strictEqual(reviewedMerge(o), true);
  assert.strictEqual(reviewedMerge({ ...o, parents: ['d'] }), false); // squash / rebase: not a merge commit
  assert.strictEqual(reviewedMerge({ ...o, parents: ['r1', 'd'] }), false);
  assert.strictEqual(reviewedMerge({ ...o, parents: ['d', 'x'] }), false); // not the merged PR's head
  assert.strictEqual(reviewedMerge({ ...o, since: 'd2' }), false); // the deployed commit moved
  assert.strictEqual(reviewedMerge({ ...o, healTree: 't2' }), false); // the server changed since the review
  assert.strictEqual(reviewedMerge({ ...o, tree: '' }), false);
});

// The engineers' PR head in the RM layout is m1 itself: the check, branchSame and the join must read it as
// the heal (the record), not as its 1st parent D.
test('the reviewer\'s merge of a reconciliation PR is a heal subject, so an m1 head is its own heal', () => {
  const m1 = 'Merge pull request #12 from saucal/reconciliation-main';
  assert.strictEqual(isHealSubject(m1), true);
  assert.strictEqual(healOf('m1', m1, 'd'), 'm1');
  assert.strictEqual(isHealSubject('Merge pull request #13 from saucal/selfheal-undeployed-main'), false);
  assert.strictEqual(isHealSubject('Merge pull request #14 from saucal/feature-x'), false);
  assert.strictEqual(healOf('ft', "Merge main's 1 undeployed commit(s) on top of the self-heal", 'm1'), 'm1');
});

test('tipNote names the PR that reviewed the heal', () => {
  const n = tipNote('main', { commits: 1, since: 'd'.repeat(40), rm: 'e'.repeat(40), logins: ['alice'], reviewed: '12' });
  assert.match(n, /healed on the last deployed commit \(`ddddddd`\) and reviewed in #12; its merge `eeeeeee` is what the built repo records/);
  assert.match(n, /never merged automatically\*\*: merging it runs a normal Deploy/);
  assert.doesNotMatch(tipNote('main', { commits: 1, since: 'd'.repeat(40), rm: 'e'.repeat(40), logins: [] }), /reviewed in/);
});

// The graph, with real git: PR 1's diff is r1 vs D only; the reviewer's merge m1 = merge(D, r1) has r1's
// tree; the engineers' PR head is m1 itself when it merges cleanly with the undeployed tip U.
test('graph: PR 1 = r1 on D (heal only), m1 = merge(D, r1) has r1\'s tree, engineers\' head is m1 (RM layout)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'held-base-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  const git = async (...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}` }; };
  try {
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'composer.json'), '{"a":1}\n');
    fs.writeFileSync(path.join(dir, 'theme.php'), 'v1\n');
    g('add', '.'); g('commit', '-qm', 'D');
    const D = g('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'theme.php'), 'v2 by an engineer\n');
    g('commit', '-qam', 'u1');
    const U = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', 'reconciliation-main', D);
    fs.writeFileSync(path.join(dir, 'composer.json'), '{"a":2}\n');
    g('commit', '-qam', 'Reconcile server drift on main [commit only]');
    const r1 = g('rev-parse', 'HEAD');
    assert.strictEqual(g('diff', '--name-only', D, r1), 'composer.json'); // PR 1's diff: the heal alone
    g('checkout', '-q', '-b', 'selfheal-base-main', D);
    g('merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from saucal/reconciliation-main', r1);
    const m1 = g('rev-parse', 'HEAD');
    const parents = g('rev-list', '--parents', '-n', '1', m1).split(' ').slice(1);
    assert.ok(reviewedMerge({ parents, prHead: r1, since: D, tree: g('rev-parse', `${m1}^{tree}`), healTree: g('rev-parse', `${r1}^{tree}`) }));
    // run A's tree: the heal on the tip = what git's merge of m1 and U writes when nothing conflicts.
    const tipTree = g('merge-tree', '--write-tree', U, m1).split('\n')[0];
    const tip = await tipHead({ git, base: U, rm: m1, tipTree, message: 'unused' });
    assert.deepStrictEqual(tip, { head: m1, layout: 'RM' });
    assert.strictEqual(healOf(tip.head, g('log', '-1', '--format=%s', tip.head), parents[0]), m1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('index.js: held + undeployed opens PR 1 into selfheal-base-<ref>; its merge then routes as the engineers\' PR', () => {
  // PR 1: no RM/FT, head R on D, base the temporary branch, created non-force before the push.
  assert.match(src, /const heldTwo = !!\(tipResult && !toEngineers\);/);
  assert.match(src, /if \(heldTwo\) await must\(\['checkout', '-q', '-B', prBranch, headSha\], cwd\);\n  if \(tipResult && !heldTwo\) \{/);
  assert.match(src, /if \(heldTwo && !\(await ensureBase\(repo, ref, branch, pending\.since\)\)\) return;\n  \/\/ Skip the push/);
  assert.match(src, /baseSha: heldTwo \? pending\.since : baseSha/);
  assert.match(src, /const prBase = heldTwo \? baseBranchOf\(ref\) : ref;/);
  assert.match(src, /'--base', prBase,/);
  assert.match(src, /joinedComment\([^\n]*\), prBase\);/);
  // The reviewed merge: only for a held heal with undeployed commits, not on compromise signals; its m1 is RM.
  assert.match(src, /const reviewed = tipResult && !toEngineers && !inPlace && staged\.length && !\(\(security && security\.critical\) \|\| \[\]\)\.length\n    \? await reviewedHeal\(repo, ref, cwd, pending\.since, await must\(\['write-tree'\], cwd\)\) : null;/);
  assert.match(src, /const rm = reviewed \? \{ code: 0, out: reviewed\.m1 \} : await sh\('git', \['commit-tree'/);
  assert.match(src, /core\.setOutput\('auto-merge', toEngineers \|\| /); // verify records it
  assert.match(src, /core\.setOutput\('pending-paths', reviewed \? reviewed\.pending : /);
  // ensureBase never force-updates the base: create, or a non-force fast-forward.
  const eb = src.slice(src.indexOf('async function ensureBase'), src.indexOf('/** Route the undeployed-tip PR'));
  assert.match(eb, /'-F', 'force=false'/);
  assert.doesNotMatch(eb, /force=true|--force/);
  // The base goes with the reconciliation PR, after it is closed.
  const cs = src.slice(src.indexOf('async function closeStale'), src.indexOf('async function reviewedHeal'));
  assert.ok(cs.indexOf("'state=closed'") < cs.indexOf('baseBranchOf('), cs);
});

// Green check (CLEANUP_ONLY) with PR 1 open: the PR is closed, then its branch and the temporary base go.
test('cleanup step: closing the held PR deletes selfheal-base-<ref> after it', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'held-base-cleanup-'));
  const bin = path.join(ws, 'bin');
  const built = path.join(ws, 'built');
  fs.mkdirSync(bin); fs.mkdirSync(built);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').appendFileSync(process.env.GH_LOG, JSON.stringify(a) + '\\n');
const j = a.join(' ');
process.stdout.write(/pulls\\?head=o:reconciliation-main&state=open/.test(j) ? '9' : /selfheal-undeployed-main&state=/.test(j) ? '[]' : '');
`, { mode: 0o755 });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'init', '-q'], { cwd: built });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', `Build changes from ${'a'.repeat(40)}`], { cwd: built });
  const log = path.join(ws, 'gh.log');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GH_LOG: log, RUNNER_TEMP: ws, CLEANUP_ONLY: '1', REPO: 'o/r', REF: 'main', BUILT_DIR: built, RUN_URL: 'u' };
  delete env.GITHUB_OUTPUT; delete env.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js')], { env, encoding: 'utf8' });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).join(' '));
  fs.rmSync(ws, { recursive: true, force: true });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  const at = (re) => calls.findIndex((c) => re.test(c));
  assert.ok(at(/pulls\/9 -f state=closed/) >= 0, calls.join('\n'));
  assert.ok(at(/DELETE repos\/o\/r\/git\/refs\/heads\/reconciliation-main$/) > at(/pulls\/9 -f state=closed/), calls.join('\n'));
  assert.ok(at(/DELETE repos\/o\/r\/git\/refs\/heads\/selfheal-base-main$/) > at(/pulls\/9 -f state=closed/), calls.join('\n'));
});
