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
