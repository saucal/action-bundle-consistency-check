'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { undeployed } = require('../lib/undeployed');

/** A repo whose first commit is the deployed one; returns { dir, since, commit(files, msg) }. */
function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'undeployed-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ci@example.com');
  git('config', 'user.name', 'ci');
  const commit = (fl, msg) => {
    for (const [f, s] of Object.entries(fl)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), typeof s === 'string' ? s : JSON.stringify(s));
    }
    git('add', '-A');
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit, since: commit(files, 'deployed') };
}

const lock = { packages: [{ name: 'vendor/a', version: '1.0.0' }, { name: 'vendor/b', version: '1.0.0' }] };
const withPatches = (patches) => ({ require: { 'vendor/a': '1.0.0', 'vendor/b': '1.0.0' }, extra: { patches } });
const entryA = { 'vendor/a': [{ description: 'local edits', url: 'patches/a.patch', depth: 1 }] };

test('a patch file changed by undeployed commits marks its package, version unchanged', async () => {
  const r = repo({ 'composer.json': withPatches(entryA), 'composer.lock': lock, 'patches/a.patch': 'old\n' });
  const tip = r.commit({ 'patches/a.patch': 'new\n' }, 'change the patch');
  const p = await undeployed(r.since, r.dir, tip, 'main');
  assert.deepStrictEqual([...p.packages], ['vendor/a']);
});

test('a patch entry added by undeployed commits marks its package', async () => {
  const r = repo({ 'composer.json': withPatches({}), 'composer.lock': lock });
  const tip = r.commit({ 'composer.json': withPatches(entryA), 'patches/a.patch': 'x\n' }, 'add a patch');
  assert.deepStrictEqual([...(await undeployed(r.since, r.dir, tip, 'main')).packages], ['vendor/a']);
});

test('cweagans v1 map entries count too; untouched patches do not', async () => {
  const v1 = { 'vendor/a': { 'local edits': './patches/a.patch' }, 'vendor/b': { other: 'patches/b.patch' } };
  const r = repo({ 'composer.json': withPatches(v1), 'composer.lock': lock, 'patches/a.patch': 'old\n', 'patches/b.patch': 'b\n' });
  const tip = r.commit({ 'patches/a.patch': 'new\n' }, 'change a');
  assert.deepStrictEqual([...(await undeployed(r.since, r.dir, tip, 'main')).packages], ['vendor/a']);
});

test('version changes still count; nothing pending when the tip is the deployed commit', async () => {
  const r = repo({ 'composer.json': withPatches({}), 'composer.lock': lock });
  assert.strictEqual(await undeployed(r.since, r.dir, r.since, 'main'), null);
  const tip = r.commit({ 'composer.lock': { packages: [lock.packages[0], { name: 'vendor/b', version: '1.1.0' }] } }, 'bump b');
  assert.deepStrictEqual([...(await undeployed(r.since, r.dir, tip, 'main')).packages], ['vendor/b']);
});

test('counts work commits only: a merge-button merge is not a commit of its own', async () => {
  const r = repo({ 'composer.json': withPatches({}), 'composer.lock': lock });
  r.git('checkout', '-qb', 'feature');
  r.commit({ 'README.md': 'feature\n' }, 'feature work');
  r.git('checkout', '-q', 'main');
  r.git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
  const tip = r.git('rev-parse', 'HEAD');
  assert.strictEqual((await undeployed(r.since, r.dir, tip, 'main')).commits, 1);
});

test('a merge at the shallow fetch boundary is not counted as a work commit', async () => {
  const r = repo({ 'composer.json': withPatches({}), 'composer.lock': lock });
  const at = (days) => ({ ...process.env, GIT_COMMITTER_DATE: `${Math.floor(Date.now() / 1000 - days * 86400)} +0000`, GIT_AUTHOR_DATE: `${Math.floor(Date.now() / 1000 - days * 86400)} +0000` });
  const git = (env, ...a) => execFileSync('git', a, { cwd: r.dir, encoding: 'utf8', env }).trim();
  git(at(10), 'commit', '-q', '--amend', '--no-edit', '--reset-author');
  const old = git(at(10), 'rev-parse', 'HEAD');
  git(at(10), 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(r.dir, 'a.txt'), 'a\n');
  git(at(10), 'add', '-A');
  git(at(10), 'commit', '-qm', 'old work');
  // The merge is inside the fetch window (a day before the deployed commit); both its parents are older.
  git(at(10), 'checkout', '-q', '-B', 'main', old);
  git(at(1.5), 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
  const merge = git(at(1.5), 'rev-parse', 'HEAD');
  git(at(1), 'checkout', '-q', 'feature');
  fs.writeFileSync(path.join(r.dir, 'b.txt'), 'b\n');
  git(at(1), 'add', '-A');
  git(at(1), 'commit', '-qm', 'deployed');
  const since = git(at(1), 'rev-parse', 'HEAD');
  git(at(0), 'checkout', '-q', 'main');
  git(at(0), 'merge', '-q', '--no-ff', '-m', 'Merge deployed', since);
  fs.writeFileSync(path.join(r.dir, 'c.txt'), 'c\n');
  git(at(0), 'add', '-A');
  git(at(0), 'commit', '-qm', 'undeployed work');
  const tip = git(at(0), 'rev-parse', 'HEAD');

  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'undeployed-clone-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', '-b', 'main', `file://${r.dir}`, clone]);
  const p = await undeployed(since, clone, tip, 'main');
  // The window really did graft the merge parentless: that is the case under test.
  assert.strictEqual(execFileSync('git', ['rev-list', '--parents', '-n1', merge], { cwd: clone, encoding: 'utf8' }).trim(), merge);
  assert.strictEqual(p.commits, 1);
});

test('only a merge after the deployed commit, same tree: nothing pending', async () => {
  const r = repo({ 'composer.json': withPatches({}), 'composer.lock': lock });
  // An earlier heal: R (parity, the deployed commit) on the old tip, then F merges the old tip back in.
  const parity = r.commit({ 'README.md': 'healed\n' }, 'Reconcile server drift');
  const tip = r.git('commit-tree', `${parity}^{tree}`, '-p', parity, '-p', r.since, '-m', 'Apply after parity');
  assert.strictEqual(await undeployed(parity, r.dir, tip, 'main'), null);
});
