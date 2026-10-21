'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcileRun } = require('../lib/reconcile-run');

function tmpSource(require = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'src-'));
  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify({ name: 't/t', require }, null, 4) + '\n');
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
    if (slug === 'hello-dolly') return { source: 'wpackagist-plugin', package: 'wpackagist-plugin/hello-dolly', version: '1.7.2' };
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

  // fake runner: a baseline `composer install` (env probe), a partial `composer update <pkg>`
  // (no -W — siblings stay locked; it succeeds, so no -W escalation), then the lock-hash refresh
  // because composer.json gained a require.
  assert.strictEqual(runner.calls.length, 3);
  assert.deepStrictEqual(runner.calls[2].args.slice(0, 2), ['update', '--lock']);
  assert.strictEqual(runner.calls[0].args[0], 'install');
  const upd = runner.calls.find((k) => k.args[0] === 'update');
  assert.ok(upd, 'an update call was made');
  assert.ok(upd.args.includes('wpackagist-plugin/code-snippets'));
  assert.ok(!upd.args.includes('-W'), 'first update is partial (no -W)');
  // Install pins the EXACT server version into the lock (not >=latest) via --with.
  assert.ok(upd.args.includes('--with'), 'uses --with to lock the exact version');
  assert.ok(upd.args.includes('wpackagist-plugin/code-snippets:3.6.5'), '--with names the server version');
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

test('existing RANGE constraint is NOT bumped; exact server version installed via --with', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '>=1.0.0' });
  const runner = fakeRunner();
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner });

  // composer.json constraint left exactly as-is (not raised to >=3.6.5).
  const composer = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.strictEqual(composer.require['wpackagist-plugin/code-snippets'], '>=1.0.0');
  // but the lock is pinned to the server version via --with.
  const upd = runner.calls.find((k) => k.args[0] === 'update' && k.args.includes('wpackagist-plugin/code-snippets'));
  assert.ok(upd.args.includes('wpackagist-plugin/code-snippets:3.6.5'), '--with pins server version');
  assert.ok(res.applied.includes('require:wpackagist-plugin/code-snippets'));
});

test('a PINNED constraint the server moved past is lifted to >= the server version and locked there', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '3.0.0' });
  const runner = fakeRunner();
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner });

  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.recoverable, true);
  assert.deepStrictEqual(c.constraintRelaxed, { from: '3.0.0', to: '>=3.6.5' });
  const cj = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.strictEqual(cj.require['wpackagist-plugin/code-snippets'], '>=3.6.5');
  assert.ok(runner.calls.some((k) => k.args[0] === 'update' && k.args.includes('wpackagist-plugin/code-snippets:3.6.5')), 'locked to the server version');
  assert.ok(res.applied.includes('require:wpackagist-plugin/code-snippets:relaxed'), res.applied.join(','));
  assert.ok(res.autoMerge.ok, res.autoMerge.reasons.join(' | '));
});

// A runner whose update succeeds only once composer.json allows the server version.
function constraintRunner(sourceDir, pkg, ok) {
  return { calls: [], composer(args) {
    this.calls.push({ args });
    if (args[0] !== 'update' || !args.includes(pkg)) return { code: 0, stdout: '', stderr: '' };
    const c = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8')).require[pkg];
    return ok(c) ? { code: 0, stdout: '', stderr: '' } : { code: 2, stdout: '', stderr: `Root composer.json requires ${pkg} ${c}` };
  } };
}

test('a floor above the server version (downgrade) is lowered to >= the server version', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '>=4.0' });
  const runner = constraintRunner(sourceDir, 'wpackagist-plugin/code-snippets', (c) => c === '>=3.6.5');
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner });
  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.recoverable, true);
  assert.deepStrictEqual(c.constraintRelaxed, { from: '>=4.0', to: '>=3.6.5' });
});

test('relaxing does not help -> constraint restored, flagged version-unavailable for a human', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '3.0.0' });
  const runner = constraintRunner(sourceDir, 'wpackagist-plugin/code-snippets', () => false);
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner });
  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.category, 'version-unavailable');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8')).require['wpackagist-plugin/code-snippets'], '3.0.0', 'pin restored');
});

test('a PINNED constraint already equal to the server version is a clean no-op (pinned-ok)', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '3.6.5' });
  const runner = fakeRunner();
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner });

  assert.ok(res.applied.includes('require:wpackagist-plugin/code-snippets:pinned-ok'));
  assert.ok(!runner.calls.some((k) => k.args[0] === 'update' && k.args.includes('wpackagist-plugin/code-snippets')), 'no install attempted');
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
  assert.strictEqual(composer.require['saucal/composer-patches'], '>=1.1.0', 'saucal/composer-patches required');
  assert.strictEqual(composer.config['allow-plugins']['cweagans/composer-patches'], true, 'cweagans allowed');
  assert.strictEqual(composer.config['allow-plugins']['saucal/composer-patches'], true, 'reapply plugin allowed');
  assert.ok(res.applied.includes('bootstrap:cweagans'), res.applied.join(','));

  // The plugin stays a recoverable patch candidate and gets patched (relock ran).
  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.category, 'patched-candidate');
  const cmds = runner.calls.map((k) => k.args.join(' '));
  assert.ok(cmds.some((a) => a.includes('patches-relock')), cmds.join(' | '));
  assert.ok(res.applied.some((a) => a.startsWith('patched:code-snippets')), res.applied.join(','));
});

// --- security scan of server-derived content ---------------------------------------------
const showMissing = () => ({ calls: [], composer(args) { this.calls.push(args); return { code: args[0] === 'show' ? 1 : 0, stdout: '', stderr: '' }; } });

test('security: a component with critical signals is NOT adopted and is reported, even with adopt on', async () => {
  const sourceDir = tmpSource();
  const treeRoot = premiumTree();
  // Shape of a planted backdoor: hides users and plugins (assembled, not a working sample).
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'premiumplug', 'premiumplug.php'),
    "<?php\nadd_action('pre_user_query', 'x');\nadd_filter('all_plugins', 'y');\n");

  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: premiumManifest, resolvers: noResolve, runner: showMissing(), adopt: true });

  const c = res.classified.find((x) => x.key === 'premiumplug');
  assert.strictEqual(c.category, 'suspicious', 'held for review, not adopted');
  assert.strictEqual(c.recoverable, false);
  assert.deepStrictEqual(res.adoptedPaths, []);
  assert.ok(!fs.existsSync(path.join(sourceDir, 'plugins/premiumplug')), 'nothing vendored');
  assert.ok(res.security.critical.some((h) => h.rule === 'stealth' && h.file === 'plugins/premiumplug/premiumplug.php'), JSON.stringify(res.security));
});

test('security: a clean adoption has no critical findings', async () => {
  const res = await reconcileRun({ sourceDir: tmpSource(), treeRoot: premiumTree(), manifestText: premiumManifest, resolvers: noResolve, runner: showMissing(), adopt: true });
  assert.deepStrictEqual(res.security.critical, []);
  assert.strictEqual(res.classified.find((x) => x.key === 'premiumplug').category, 'adopted');
});

// --- WordPress core (class 4) ------------------------------------------------------------
function coreSource(version) {
  const dir = tmpSource();
  const p = path.join(dir, 'composer.json');
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (version) c.extra = { 'wordpress-core': version };
  fs.writeFileSync(p, JSON.stringify(c, null, 4) + '\n');
  return dir;
}
const readCore = (dir) => (JSON.parse(fs.readFileSync(path.join(dir, 'composer.json'), 'utf8')).extra || {})['wordpress-core'];

test('core: composer-managed core follows the server version, even with no file drift', async () => {
  const sourceDir = coreSource('6.9.1');
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(), coreVersionRemote: '7.1.3' });
  assert.strictEqual(readCore(sourceDir), '7.1.3');
  assert.ok(res.applied.includes('core:6.9.1->7.1.3'), res.applied.join(','));
  assert.strictEqual(res.outcome, 'reconciled');
});

test('core: no line and no server version known -> left alone', async () => {
  const sourceDir = coreSource(null);
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner() });
  assert.strictEqual(readCore(sourceDir), undefined);
  assert.strictEqual(res.outcome, 'noop');
});

test('core: already equal -> nothing to do', async () => {
  const sourceDir = coreSource('7.1.3');
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(), coreVersionRemote: '7.1.3' });
  assert.deepStrictEqual(res.applied, []);
  assert.strictEqual(res.outcome, 'noop');
});

// --- committed code (tracked) and the auto-merge decision ----------------------------------
const trackedIn = (prefixes) => (p) => prefixes.some((t) => p === t || p.startsWith(t + '/') || t.startsWith(p + '/'));
function trackedFixture(serverEdit) {
  const sourceDir = tmpSource();
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  for (const [dir, files] of [[sourceDir, { 'main.php': '<?php // v1\n', 'gone.php': '<?php // old\n' }], [treeRoot, { 'main.php': serverEdit, 'new.php': '<?php // added on server\n' }]]) {
    fs.mkdirSync(path.join(dir, 'plugins/custom'), { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'plugins/custom', f), c);
  }
  const manifestText = ['plugins/custom/main.php', 'deleting plugins/custom/new.php', 'plugins/custom/gone.php'].join('\n') + '\n';
  return { sourceDir, treeRoot, manifestText, isTracked: trackedIn(['plugins/custom/main.php', 'plugins/custom/gone.php']) };
}

test('tracked: server edits, additions and deletions are copied into source; the added file makes it wait for review', async () => {
  const f = trackedFixture("<?php // v1 with a server fix\n");
  const res = await reconcileRun({ ...f, resolvers: noResolve, runner: fakeRunner() });
  const read = (p) => fs.readFileSync(path.join(f.sourceDir, p), 'utf8');
  assert.strictEqual(read('plugins/custom/main.php'), "<?php // v1 with a server fix\n");
  assert.strictEqual(read('plugins/custom/new.php'), '<?php // added on server\n');
  assert.ok(!fs.existsSync(path.join(f.sourceDir, 'plugins/custom/gone.php')), 'deleted on server -> deleted in source');
  assert.deepStrictEqual(res.trackedPaths.sort(), ['plugins/custom/gone.php', 'plugins/custom/main.php', 'plugins/custom/new.php']);
  assert.strictEqual(res.autoMerge.ok, false, 'a file the server added waits for a human');
  assert.ok(res.autoMerge.reasons.some((r) => /new-file/.test(r)), res.autoMerge.reasons.join(' | '));
});

test('tracked: an edit to an existing committed file with no risky signal merges unattended', async () => {
  const sourceDir = tmpSource();
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  for (const dir of [sourceDir, treeRoot]) fs.mkdirSync(path.join(dir, 'plugins/custom'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'plugins/custom/main.php'), '<?php // v1\n');
  fs.writeFileSync(path.join(treeRoot, 'plugins/custom/main.php'), "<?php // v1\nif ( empty( $rule ) ) { return; } // hotfix\n");
  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: 'plugins/custom/main.php\n', isTracked: trackedIn(['plugins/custom/main.php']),
    resolvers: noResolve, runner: fakeRunner() });
  assert.ok(res.autoMerge.ok, res.autoMerge.reasons.join(' | '));
});

test('tracked: compromise signals -> nothing copied, held, no auto-merge', async () => {
  const f = trackedFixture("<?php // v1\n" + 'ev' + "al(base64_decode($_POST['x']));\n");
  const res = await reconcileRun({ ...f, resolvers: noResolve, runner: fakeRunner() });
  assert.strictEqual(fs.readFileSync(path.join(f.sourceDir, 'plugins/custom/main.php'), 'utf8'), '<?php // v1\n', 'payload kept out of the PR');
  assert.strictEqual(res.classified.find((c) => c.key === 'custom').category, 'suspicious');
  assert.strictEqual(res.autoMerge.ok, false);
});

test('tracked: a hold-level signal is copied for review but blocks auto-merge', async () => {
  const f = trackedFixture("<?php // v1\n$cfg = base64_decode($opt);\n");
  const res = await reconcileRun({ ...f, resolvers: noResolve, runner: fakeRunner() });
  assert.match(fs.readFileSync(path.join(f.sourceDir, 'plugins/custom/main.php'), 'utf8'), /base64_decode/);
  assert.strictEqual(res.autoMerge.ok, false);
  assert.ok(res.autoMerge.reasons.some((r) => /decode/.test(r)), res.autoMerge.reasons.join(' | '));
});

test('auto-merge: a version move of an existing require is eligible; a new require needs a clean vulnerability check', async () => {
  const bump = await reconcileRun({ sourceDir: tmpSource({ 'wpackagist-plugin/code-snippets': '>=3.0' }), treeRoot: '/nonexistent',
    manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner() });
  assert.ok(bump.autoMerge.ok, bump.autoMerge.reasons.join(' | '));
  const add = await reconcileRun({ sourceDir: tmpSource(), treeRoot: '/nonexistent',
    manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner() });
  assert.strictEqual(add.autoMerge.ok, false, 'no vulnerability check available -> not auto');
  assert.ok(add.autoMerge.reasons.some((r) => /vulnerability check unavailable/.test(r)), add.autoMerge.reasons.join(' | '));
  const clean = await reconcileRun({ sourceDir: tmpSource(), treeRoot: '/nonexistent',
    manifestText: 'deleting plugins/hello-dolly/hello.php\n', resolvers, runner: fakeRunner(), vulnCheck: async (items) => items.map(() => ({ matches: [] })) });
  assert.ok(clean.autoMerge.ok, clean.autoMerge.reasons.join(' | '));
});

test('auto-merge: a new high-risk plugin (code snippets) waits for review even when clean; one already required keeps updating', async () => {
  const clean = async (items) => items.map(() => ({ matches: [] }));
  const add = await reconcileRun({ sourceDir: tmpSource(), treeRoot: '/nonexistent',
    manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner(), vulnCheck: clean });
  assert.strictEqual(add.autoMerge.ok, false);
  assert.ok(add.autoMerge.reasons.some((r) => /new high-risk plugin \(code snippets/.test(r)), add.autoMerge.reasons.join(' | '));
  const bump = await reconcileRun({ sourceDir: tmpSource({ 'wpackagist-plugin/code-snippets': '>=3.0' }), treeRoot: '/nonexistent',
    manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner(), vulnCheck: clean });
  assert.ok(bump.autoMerge.ok, bump.autoMerge.reasons.join(' | '));
});

test('auto-merge: a downgrade below the locked version is not eligible', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '>=3.0' });
  fs.writeFileSync(path.join(sourceDir, 'composer.lock'), JSON.stringify({ packages: [{ name: 'wpackagist-plugin/code-snippets', version: '3.7.0' }] }));
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner() });
  assert.strictEqual(res.autoMerge.ok, false);
  assert.ok(res.autoMerge.reasons.some((r) => /vulnerability check unavailable/.test(r)), res.autoMerge.reasons.join(' | '));
});

test('vulns: a downgrade into a known-vulnerable version is held; a clean one auto-merges', async () => {
  const mk = () => {
    const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '>=3.0' });
    fs.writeFileSync(path.join(sourceDir, 'composer.lock'), JSON.stringify({ packages: [{ name: 'wpackagist-plugin/code-snippets', version: '3.7.0' }] }));
    return sourceDir;
  };
  const asked = [];
  const vulnerable = await reconcileRun({ sourceDir: mk(), treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner(),
    vulnCheck: async (items) => { asked.push(...items); return items.map(() => ({ matches: [{ id: 'wf-1', title: 'XSS', cve: 'CVE-2026-1', fixed_in: '3.6.6' }] })); } });
  assert.deepStrictEqual(asked, [{ type: 'plugin', slug: 'code-snippets', version: '3.6.5' }]);
  assert.strictEqual(vulnerable.autoMerge.ok, false);
  assert.ok(vulnerable.autoMerge.reasons.some((r) => /known vulnerabilit.*CVE-2026-1/.test(r)), vulnerable.autoMerge.reasons.join(' | '));
  const clean = await reconcileRun({ sourceDir: mk(), treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner: fakeRunner(),
    vulnCheck: async (items) => items.map(() => ({ matches: [] })) });
  assert.ok(clean.autoMerge.ok, clean.autoMerge.reasons.join(' | '));
});

test('lock hash: any composer.json change ends with `composer update --lock` (extra is part of the hash)', async () => {
  const sourceDir = coreSource('6.9.1');
  const runner = fakeRunner();
  await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner, coreVersionRemote: '7.1.3' });
  const last = runner.calls[runner.calls.length - 1];
  assert.deepStrictEqual(last && last.args.slice(0, 2), ['update', '--lock'], JSON.stringify(runner.calls.map((c) => c.args.join(' '))));
});

test('lock hash: no composer.json change, no lock refresh', async () => {
  const runner = fakeRunner();
  await reconcileRun({ sourceDir: coreSource('7.1.3'), treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner, coreVersionRemote: '7.1.3' });
  assert.ok(!runner.calls.some((c) => c.args[0] === 'update' && c.args[1] === '--lock'));
});

test('removed: a plugin gone from the server drops its require (and is auto-merge eligible)', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '>=3.0' });
  const runner = fakeRunner();
  const res = await reconcileRun({ sourceDir, treeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'tree-')),
    manifestText: 'plugins/code-snippets/code-snippets.php\n', resolvers, runner });
  const cj = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.strictEqual(cj.require['wpackagist-plugin/code-snippets'], undefined);
  assert.ok(res.applied.includes('remove:wpackagist-plugin/code-snippets'), res.applied.join(','));
  assert.ok(runner.calls.some((c) => c.args[0] === 'update' && c.args[1] === 'wpackagist-plugin/code-snippets'), 'lock updated');
  assert.ok(res.autoMerge.ok, res.autoMerge.reasons.join(' | '));
});

// --- split: merge what needs no review now, leave the rest for the next run's PR --------------
function mixedFixture() {
  const f = trackedFixture("<?php // v1 with a server fix\n");
  // a clean addition (merges now), a plugin whose version has a known vulnerability, and the server's
  // edit to committed code (both wait for review)
  f.manifestText += 'deleting plugins/hello-dolly/hello.php\ndeleting plugins/code-snippets/code-snippets.php\n';
  return f;
}
const vulnerableAdd = async (items) => items.map((it) => ({ matches: it.slug === 'code-snippets' ? [{ id: 'wf-9', cve: 'CVE-2026-9' }] : [] }));

test('split: a mixed heal reports what is eligible now and what waits for review', async () => {
  const f = mixedFixture();
  const res = await reconcileRun({ ...f, resolvers, runner: fakeRunner(), vulnCheck: vulnerableAdd });
  assert.strictEqual(res.autoMerge.ok, false);
  assert.deepStrictEqual(res.autoMerge.eligible, ['hello-dolly']);
  assert.ok(res.autoMerge.pending.includes('/plugins/code-snippets/'), JSON.stringify(res.autoMerge.pending));
  assert.ok(res.autoMerge.pending.includes('/plugins/custom/'), JSON.stringify(res.autoMerge.pending));
});

test('split: rerun with only the eligible items -> auto-merge, the held item untouched and pending', async () => {
  const f = mixedFixture();
  const res = await reconcileRun({ ...f, resolvers, runner: fakeRunner(), vulnCheck: vulnerableAdd, only: new Set(['hello-dolly']) });
  assert.strictEqual(res.autoMerge.ok, true, res.autoMerge.reasons.join(' | '));
  assert.ok(res.autoMerge.pending.includes('/plugins/code-snippets/'));
  const req = JSON.parse(fs.readFileSync(path.join(f.sourceDir, 'composer.json'), 'utf8')).require;
  assert.strictEqual(req['wpackagist-plugin/code-snippets'], undefined, 'held item not applied');
  assert.strictEqual(fs.readFileSync(path.join(f.sourceDir, 'plugins/custom/main.php'), 'utf8'), '<?php // v1\n', 'held code not copied');
  assert.ok(req['wpackagist-plugin/hello-dolly'], 'eligible item applied');
});

test('split: junk drift does not block a heal; its path is pending for the checks', async () => {
  const sourceDir = tmpSource();
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/hello-dolly/hello.php\ndeleting debug-trace.log\n',
    resolvers, runner: fakeRunner(), vulnCheck: async (i) => i.map(() => ({ matches: [] })) });
  assert.strictEqual(res.autoMerge.ok, true, res.autoMerge.reasons.join(' | '));
  assert.ok(res.autoMerge.pending.includes('/debug-trace.log'), JSON.stringify(res.autoMerge.pending));
});

test('split: any critical signal stops all auto-merging (possible incident)', async () => {
  const f = trackedFixture("<?php // v1\n" + 'ev' + "al(base64_decode($_POST['x']));\n");
  f.manifestText += 'deleting plugins/code-snippets/code-snippets.php\n';
  const res = await reconcileRun({ ...f, resolvers, runner: fakeRunner(), vulnCheck: async (i) => i.map(() => ({ matches: [] })) });
  assert.strictEqual(res.autoMerge.ok, false);
  assert.deepStrictEqual(res.autoMerge.eligible, []);
});

test('core: on a host-managed core, extra.wordpress-core is removed (the repo cannot enforce it)', async () => {
  const sourceDir = coreSource('6.9.1');
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(),
    coreVersionRemote: '7.1.3', coreManagedByHost: true });
  assert.strictEqual(readCore(sourceDir), undefined);
  assert.ok(res.applied.includes('core:host-managed-removed'), res.applied.join(','));
  assert.ok(res.autoMerge.ok, res.autoMerge.reasons.join(' | '));
});

test('core: no line, writable core -> the line comes back at the server version (no update triggered)', async () => {
  const sourceDir = coreSource(null);
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(), coreVersionRemote: '7.1.3' });
  assert.strictEqual(readCore(sourceDir), '7.1.3');
  assert.ok(res.applied.includes('core:managed-again:7.1.3'), res.applied.join(','));
  assert.ok(res.autoMerge.ok, res.autoMerge.reasons.join(' | '));
});

test('core: no line, host-managed core -> left alone', async () => {
  const sourceDir = coreSource(null);
  await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(), coreVersionRemote: '7.1.3', coreManagedByHost: true });
  assert.strictEqual(readCore(sourceDir), undefined);
});

test('patch setup: a repo that already requires cweagans gets saucal/composer-patches', async () => {
  // Common in the fleet: cweagans required, no post-install-cmd.
  const sourceDir = tmpSource({ 'cweagans/composer-patches': '2.0.0-beta2' });
  fs.mkdirSync(path.join(sourceDir, 'plugins', 'code-snippets'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'plugins', 'code-snippets', 'code-snippets.php'), '<?php // pristine\n');
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(treeRoot, 'plugins', 'code-snippets'), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'code-snippets', 'code-snippets.php'), '<?php // pristine\n// SERVER EDIT\n');
  const res = await reconcileRun({ sourceDir, treeRoot, manifestText: 'deleting plugins/code-snippets/code-snippets.php\n',
    contentDiffText: 'diff --git plugins/code-snippets/code-snippets.php plugins/code-snippets/code-snippets.php\n@@ -1 +1 @@\n-a\n+b\n', resolvers, runner: fakeRunner() });
  const cj = JSON.parse(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'));
  assert.strictEqual(cj.require['cweagans/composer-patches'], '2.0.0-beta2', 'its own constraint kept');
  assert.strictEqual(cj.require['saucal/composer-patches'], '>=1.1.0');
  assert.strictEqual(cj.scripts, undefined, 'no script hook');
  assert.ok(res.applied.includes('patch-setup:completed'), res.applied.join(','));
  assert.ok(!res.applied.includes('bootstrap:cweagans'));
});

test('auto-merge: a new plugin shipping package.json scripts waits for review only when a workspace pattern covers it', async () => {
  const clean = async (items) => items.map(() => ({ matches: [] }));
  const mk = (workspace) => {
    const sourceDir = tmpSource();
    fs.writeFileSync(path.join(sourceDir, 'package.json'), '{"name":"site","private":true}\n');
    if (workspace) fs.writeFileSync(path.join(sourceDir, 'pnpm-workspace.yaml'), workspace);
    fs.mkdirSync(path.join(sourceDir, 'plugins/hello-dolly/tools'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'plugins/hello-dolly/tools/package.json'), '{"scripts":{"postinstall":"node x.js"}}\n');
    return sourceDir;
  };
  const run = (sourceDir) => reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/hello-dolly/hello.php\n', resolvers, runner: fakeRunner(), vulnCheck: clean });
  const glob = await run(mk('packages:\n  - "plugins/*"\n  - themes/site\n'));
  assert.strictEqual(glob.autoMerge.ok, false);
  assert.ok(glob.autoMerge.reasons.some((r) => /ships package.json scripts/.test(r)), glob.autoMerge.reasons.join(' | '));
  const explicit = await run(mk('packages:\n  - themes/site\n  - plugins/site-core\n'));
  assert.ok(explicit.autoMerge.ok, explicit.autoMerge.reasons.join(' | '));
  const none = await run(mk(null));
  assert.ok(none.autoMerge.ok, none.autoMerge.reasons.join(' | '));
});

test('pending: a drifted version undeployed commits also changed is superseded — the repo version stands', async () => {
  const sourceDir = tmpSource({ 'wpackagist-plugin/code-snippets': '>=3.0' });
  const before = fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8');
  const runner = fakeRunner();
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: 'deleting plugins/code-snippets/code-snippets.php\n', resolvers, runner,
    pending: { since: 'a'.repeat(40), packages: new Set(['wpackagist-plugin/code-snippets']), files: [], core: false } });
  const c = res.classified.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.category, 'superseded');
  assert.strictEqual(fs.readFileSync(path.join(sourceDir, 'composer.json'), 'utf8'), before, 'composer.json untouched');
  assert.ok(!runner.calls.some((k) => k.args.includes('wpackagist-plugin/code-snippets')), 'no composer update for it');
  assert.ok(!res.autoMerge.reasons.some((r) => /needs a human/.test(r)), res.autoMerge.reasons.join(' | '));
});

test('pending: drifted committed code undeployed commits also changed waits for review', async () => {
  const f = trackedFixture('<?php // v2 from the server\n');
  const res = await reconcileRun({ ...f, resolvers: noResolve, runner: fakeRunner(),
    pending: { since: 'b'.repeat(40), packages: new Set(), files: ['plugins/custom/main.php'], core: false } });
  assert.strictEqual(res.autoMerge.ok, false);
  assert.ok(res.autoMerge.reasons.some((r) => /not yet deployed .* review which version should win/.test(r)), res.autoMerge.reasons.join(' | '));
});

test('pending: core drift with an undeployed core change keeps the repo line', async () => {
  const sourceDir = coreSource('6.9.1');
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(), coreVersionRemote: '6.9.4',
    pending: { since: 'c'.repeat(40), packages: new Set(), files: [], core: true } });
  assert.strictEqual(readCore(sourceDir), '6.9.1');
  assert.strictEqual(res.classified.find((x) => x.key === 'wordpress-core').category, 'superseded');
});

test('pending: an undeployed commit that dropped the core line is not undone', async () => {
  const sourceDir = coreSource(null);
  const res = await reconcileRun({ sourceDir, treeRoot: '/nonexistent', manifestText: '', resolvers: noResolve, runner: fakeRunner(), coreVersionRemote: '6.9.4',
    pending: { since: 'e'.repeat(40), packages: new Set(), files: ['composer.json'], core: true } });
  assert.strictEqual(readCore(sourceDir), undefined, 'line stays dropped');
  assert.ok(!res.applied.some((a) => a.startsWith('core:managed-again')), res.applied.join(','));
});
