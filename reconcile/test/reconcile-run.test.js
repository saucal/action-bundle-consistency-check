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

  // fake runner: a baseline `composer install` (env probe) then a partial `composer update <pkg>`
  // (no -W — siblings stay locked). It succeeds, so no -W escalation.
  assert.strictEqual(runner.calls.length, 2);
  assert.strictEqual(runner.calls[0].args[0], 'install');
  const upd = runner.calls.find((k) => k.args[0] === 'update');
  assert.ok(upd, 'an update call was made');
  assert.ok(upd.args.includes('wpackagist-plugin/code-snippets'));
  assert.ok(!upd.args.includes('-W'), 'first update is partial (no -W)');
  assert.strictEqual(upd.opts.cwd, sourceDir);

  assert.deepStrictEqual(res.applied, ['require:wpackagist-plugin/code-snippets']);
});

test('unavailable: composer update fails -> constraint reverted, flagged version-unavailable', async () => {
  const sourceDir = tmpSource();
  const before = fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8');
  // Env works (install ok) but the version is unsatisfiable (update fails) — the exact case
  // the availability gate must catch without misattributing it to a broken environment.
  const runner = {
    calls: [],
    composer(args, opts) {
      this.calls.push({ args, opts });
      return { code: args[0] === 'install' ? 0 : 1, stdout: '', stderr: args[0] === 'install' ? '' : 'not found' };
    },
  };
  const manifestText = 'deleting plugins/code-snippets/code-snippets.php\n';

  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText, resolvers, runner });

  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.category, 'version-unavailable');
  assert.strictEqual(c.recoverable, false);
  // composer.json reverted to its original bytes — no uninstallable constraint left behind.
  assert.strictEqual(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'), before);
  assert.ok(res.applied.includes('require:wpackagist-plugin/code-snippets:unavailable'), res.applied.join(','));
  assert.strictEqual(res.outcome, 'unrecoverable-only');
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

// Server tree carrying an unresolvable "premium" plugin (on neither wpackagist nor satispress).
function premiumTree() {
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(treeRoot, 'plugins', 'premiumplug'), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'premiumplug', 'premiumplug.php'), '<?php // premium\n');
  return treeRoot;
}
const noResolve = { async wpackagist() { return null; }, async satispress() { return null; } };
const premiumManifest = 'deleting plugins/premiumplug/premiumplug.php\n';

test('adopt: premium-flag component is vendored into source when the flag is on', async () => {
  const sourceDir = tmpSource();
  const treeRoot = premiumTree();
  // composer `show` returns nonzero (not resolvable) so adoption proceeds; other calls succeed.
  const runner = { calls: [], composer(args) { this.calls.push(args); return { code: args[0] === 'show' ? 1 : 0, stdout: '', stderr: '' }; } };

  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: premiumManifest, resolvers: noResolve, runner, adopt: true });

  const c = res.classified.find((x) => x.key === 'premiumplug');
  assert.strictEqual(c.category, 'adopted');
  assert.strictEqual(c.recoverable, true);
  assert.ok(fs.existsSync(path.join(sourceDir, 'plugins/premiumplug/premiumplug.php')), 'vendored into source');
  assert.deepStrictEqual(res.adoptedPaths, ['plugins/premiumplug']);
  assert.ok(res.applied.includes('adopt:premiumplug'), res.applied.join(','));
  // Verify pass: the vendored source now byte-matches the captured server state → reproduces it.
  assert.strictEqual(c.verified, true);
  assert.deepStrictEqual(res.verification, { verified: 1, verifiable: 1, residual: 0 });
});

test('verify: adopted-lossy (a non-manifest sensitive file skipped) reports residual — does NOT fully converge', async () => {
  const sourceDir = tmpSource();
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(treeRoot, 'plugins', 'premiumplug', 'inc'), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'premiumplug', 'premiumplug.php'), '<?php // premium\n');
  // Credentials file present in the server dir but NOT in the drift manifest: adopt's full-dir
  // copy hits and skips it (sensitive), so the vendored plugin is missing it → residual.
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'premiumplug', 'inc', 'secret-credentials.php'), '<?php return ["k"=>"v"];\n');
  const runner = { calls: [], composer(args) { return { code: args[0] === 'show' ? 1 : 0, stdout: '', stderr: '' }; } };

  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: premiumManifest, resolvers: noResolve, runner, adopt: true });

  const c = res.classified.find((x) => x.key === 'premiumplug');
  assert.strictEqual(c.category, 'adopted-lossy');
  assert.strictEqual(c.verified, false);
  assert.ok(c.residualFiles >= 1, `residualFiles: ${c.residualFiles}`);
  assert.strictEqual(res.verification.residual, 1);
  assert.ok(!fs.existsSync(path.join(sourceDir, 'plugins/premiumplug/inc/secret-credentials.php')), 'sensitive file not vendored');
});

test('adopt: off by default -> premium-flag stays flagged, nothing vendored', async () => {
  const sourceDir = tmpSource();
  const treeRoot = premiumTree();
  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: premiumManifest, resolvers: noResolve, runner: fakeRunner() });

  const c = res.classified.find((x) => x.key === 'premiumplug');
  assert.strictEqual(c.category, 'premium-flag');
  assert.strictEqual(c.recoverable, false);
  assert.ok(!fs.existsSync(path.join(sourceDir, 'plugins/premiumplug/premiumplug.php')));
  assert.deepStrictEqual(res.adoptedPaths, []);
});

test('adopt: composer show finds the package -> skip vendoring (would fork a resolvable plugin)', async () => {
  const sourceDir = tmpSource();
  const treeRoot = premiumTree();
  // `show` returns 0 => package IS resolvable => must not vendor.
  const runner = { calls: [], composer(args) { this.calls.push(args); return { code: 0, stdout: '', stderr: '' }; } };

  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: premiumManifest, resolvers: noResolve, runner, adopt: true });

  const c = res.classified.find((x) => x.key === 'premiumplug');
  assert.strictEqual(c.category, 'premium-flag', 'unchanged — not adopted');
  assert.ok(!fs.existsSync(path.join(sourceDir, 'plugins/premiumplug/premiumplug.php')));
  assert.ok(res.applied.includes('adopt:premiumplug:skipped-resolvable'), res.applied.join(','));
});

test('adopt: a sensitive component is never adopted (stays flagged), even with the flag on', async () => {
  const sourceDir = tmpSource();
  // credentials mu-plugin drift classifies as `sensitive`, not `premium-flag`.
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/spy/secret-credentials.php\n', resolvers: noResolve, runner: fakeRunner(), adopt: true });
  const c = res.classified.find((x) => x.key === 'spy');
  assert.strictEqual(c.category, 'sensitive');
  assert.deepStrictEqual(res.adoptedPaths, []);
});

test('no cweagans: a modified-from-published plugin BOOTSTRAPS the patch setup, then patches', async () => {
  const sourceDir = tmpSource(); // composer.json has require {} — no cweagans/composer-patches
  // Pristine installed copy (so reconcile-patched's generatePatch has a real dir to diff).
  fs.mkdirSync(path.join(sourceDir, 'plugins', 'code-snippets'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'plugins', 'code-snippets', 'code-snippets.php'), '<?php // pristine\n');
  // Server-state tree with the same plugin edited.
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(treeRoot, 'plugins', 'code-snippets'), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'code-snippets', 'code-snippets.php'), '<?php // pristine\n// SERVER EDIT\n');

  const runner = fakeRunner();
  const manifestText = 'deleting plugins/code-snippets/code-snippets.php\n';
  const contentDiffText = 'diff --git plugins/code-snippets/code-snippets.php plugins/code-snippets/code-snippets.php\n@@ -1 +1 @@\n-a\n+b\n';

  const res = await reconcileRun({ sourceDir, treeRoot, manifestText, contentDiffText, resolvers, runner });

  // cweagans setup was written into composer.json.
  const composer = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.strictEqual(composer.require['cweagans/composer-patches'], '>=2.0.0', 'cweagans required');
  assert.strictEqual(composer.config['allow-plugins']['cweagans/composer-patches'], true, 'cweagans allowed');
  assert.ok(composer.scripts['post-install-cmd'].some((l) => l.includes('.patches_applied')), 'hook added');
  assert.ok(res.applied.includes('bootstrap:cweagans'), res.applied.join(','));

  // The plugin stays a recoverable patch candidate and gets patched (relock ran).
  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.category, 'patched-candidate');
  const cmds = runner.calls.map((k) => k.args.join(' '));
  assert.ok(cmds.some((a) => a.includes('patches-relock')), cmds.join(' | '));
  assert.ok(res.applied.some((a) => a.startsWith('patched:code-snippets')), res.applied.join(','));
});
