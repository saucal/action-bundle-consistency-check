'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcileRun } = require('../lib/reconcile-run');

function tmpSource() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ name: 't/t', require: {} }, null, 4) + '\n');
  return dir;
}

function fakeRunner() {
  const calls = [];
  return {
    calls,
    composer(args, opts) { calls.push({ args, opts }); return { code: 0, stdout: '', stderr: '' }; },
  };
}

// code-snippets resolves on wpackagist; nothing else.
const resolvers = {
  async wpackagist(kind, slug) {
    if (slug === 'code-snippets') return { source: 'wpackagist-plugin', package: 'wpackagist-plugin/code-snippets', version: '3.6.5' };
    return null;
  },
  async satispress() { return null; },
};

test('add/bump: recoverable wpackagist add writes require, runs composer update, records applied', async () => {
  const sourceDir = tmpSource();
  const runner = fakeRunner();
  const manifestText = 'deleting plugins/code-snippets/code-snippets.php\n';

  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText, resolvers, runner });

  assert.strictEqual(res.outcome, 'reconciled');

  // composer.json now requires the package.
  const composer = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.strictEqual(composer.require['wpackagist-plugin/code-snippets'], '>=3.6.5');

  // fake runner received exactly one `composer update <pkg> -W` call.
  assert.strictEqual(runner.calls.length, 1);
  const { args, opts } = runner.calls[0];
  assert.strictEqual(args[0], 'update');
  assert.ok(args.includes('wpackagist-plugin/code-snippets'));
  assert.ok(args.includes('-W'));
  assert.strictEqual(opts.cwd, sourceDir);

  assert.deepStrictEqual(res.applied, ['require:wpackagist-plugin/code-snippets']);
});

test('flag-only: sensitive item leaves composer untouched, no runner call, empty applied', async () => {
  const sourceDir = tmpSource();
  const runner = fakeRunner();
  const manifestText = 'deleting mu-plugins/00-x-credentials.php\n';

  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText, resolvers, runner });

  assert.strictEqual(res.outcome, 'unrecoverable-only');

  const composer = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.deepStrictEqual(composer.require, {});

  assert.strictEqual(runner.calls.length, 0);
  assert.deepStrictEqual(res.applied, []);
});
