'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeProject } = require('../helpers/make-project');
const { stageServer, deriveDrift } = require('../helpers/stage-server');
const { reconcileRun } = require('../../lib/reconcile-run');
const { makeRunner } = require('../../lib/runner');
const { generatePatch } = require('../../lib/patch-gen');
const os = require('os');

// Local, network-free resolver. Maps known slugs to {source, package, version}.
// Package names match what make-project installs from path repos so composer can
// actually resolve add/bump constraints. `source` controls the classify category for
// add/bump (non-modified) components.
const KNOWN = {
  newplug: { source: 'satispress', package: 'saucal/newplug', version: '1.0.0' },
  verplug: { source: 'satispress', package: 'saucal/verplug', version: '1.1.0' },
  patchplug: { source: 'satispress', package: 'saucal/patchplug', version: '1.0.0' },
  thmx: { source: 'satispress', package: 'saucal/thmx', version: '1.0.0' },
};

const fakeResolvers = {
  async wpackagist() {
    return null;
  },
  async satispress(slug) {
    return KNOWN[slug] || null;
  },
};

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function findByKey(classified, key) {
  return classified.find((c) => c.key === key);
}

// --- 1. add -------------------------------------------------------------
test('add: server has an extra plugin -> required + installed', async () => {
  const { dir } = makeProject({
    plugins: [
      { slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' },
      // present as a path repo so composer can install it, but removed from require.
      { slug: 'newplug', pkg: 'saucal/newplug', version: '1.0.0', body: '// new plugin\n' },
    ],
  });

  // Remove newplug from require + uninstall so the BUILT state lacks it.
  const composerPath = path.join(dir, 'composer.json');
  const composer = JSON.parse(read(composerPath));
  delete composer.require['saucal/newplug'];
  fs.writeFileSync(composerPath, JSON.stringify(composer, null, 4) + '\n');
  const runner = makeRunner();
  let r = await runner.composer(['update', 'saucal/newplug', '-W', '--no-progress'], { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'plugins/newplug')), 'newplug not built');

  // Server = built (without newplug) + the extra newplug dir present.
  const serverDir = stageServer(dir, (sv) => {
    const d = path.join(sv, 'plugins/newplug');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(
      path.join(d, 'newplug.php'),
      '<?php\n/**\n * Plugin Name: newplug\n * Version: 1.0.0\n */\n// new plugin\n'
    );
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner,
  });

  assert.ok(
    fs.existsSync(path.join(dir, 'plugins/newplug/newplug.php')),
    'newplug.php installed in project'
  );
  assert.ok(res.applied.includes('require:saucal/newplug'), `applied has require: ${res.applied}`);
});

// --- 2. bump ------------------------------------------------------------
test('bump: clean newer version on server -> bump-only, no patch', async () => {
  const { dir } = makeProject({
    plugins: [
      { slug: 'verplug', pkg: 'saucal/verplug', version: '1.0.0', body: '// v code\n' },
      { slug: 'verplug', pkg: 'saucal/verplug', version: '1.1.0', body: '// v code\n' },
    ],
  });
  const installed = path.join(dir, 'plugins/verplug/verplug.php');
  assert.match(read(installed), /Version: 1\.0\.0/);

  // Server carries the pristine 1.1.0 directory (clean bump, no drift vs pristine 1.1.0).
  // Replace the whole verplug dir with the 1.1.0 path-repo source (incl. its composer.json)
  // so it matches byte-for-byte what composer installs for 1.1.0.
  const src111 = path.join(dir, 'pkgs/verplug-1.1.0');
  const serverDir = stageServer(dir, (sv) => {
    const dst = path.join(sv, 'plugins/verplug');
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src111)) {
      fs.copyFileSync(path.join(src111, f), path.join(dst, f));
    }
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  assert.match(read(installed), /Version: 1\.1\.0/, 'installed bumped to 1.1.0');
  assert.ok(
    res.applied.includes('patched:verplug:bump-only'),
    `patched-candidate resolved bump-only: ${res.applied}`
  );
  assert.ok(!fs.existsSync(path.join(dir, 'patches', 'verplug.patch')), 'no patch written');
});

// --- 3. patch -----------------------------------------------------------
test('patch: server edit at same version -> patch generated + applied', async () => {
  const { dir } = makeProject({
    plugins: [{ slug: 'patchplug', pkg: 'saucal/patchplug', version: '1.0.0', body: '// app code\n' }],
  });
  const installed = path.join(dir, 'plugins/patchplug/patchplug.php');

  const serverDir = stageServer(dir, (sv) => {
    const f = path.join(sv, 'plugins/patchplug/patchplug.php');
    fs.writeFileSync(f, read(f).replace('// app code', '// app code DRIFTED'));
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  assert.match(read(installed), /\/\/ app code DRIFTED/, 'patch applied on disk');
  assert.ok(fs.existsSync(path.join(dir, 'patches/patchplug.patch')), 'patch file exists');

  const lock = JSON.parse(read(path.join(dir, 'patches.lock.json')));
  const entries = lock.patches['saucal/patchplug'];
  assert.ok(Array.isArray(entries) && entries.length === 1, 'one lock entry');
  assert.ok(typeof entries[0].sha256 === 'string' && entries[0].sha256.length > 0, 'entry sha256');
  assert.ok(res.applied.includes('patched:patchplug:patched'), `applied: ${res.applied}`);
});

// --- 4. stale -----------------------------------------------------------
test('stale: server == built -> nothing applied for component', async () => {
  const { dir } = makeProject({
    plugins: [{ slug: 'patchplug', pkg: 'saucal/patchplug', version: '1.0.0', body: '// app code\n' }],
  });
  const installed = path.join(dir, 'plugins/patchplug/patchplug.php');
  const before = read(installed);

  const serverDir = stageServer(dir, null); // identical copy

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  assert.strictEqual(manifestText.trim(), '', 'no drift manifest');

  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  assert.strictEqual(res.outcome, 'noop', 'outcome noop');
  assert.strictEqual(res.applied.length, 0, 'nothing applied');
  assert.ok(!fs.existsSync(path.join(dir, 'patches', 'patchplug.patch')), 'no patch');
  assert.strictEqual(read(installed), before, 'installed file unchanged');
});

// --- 5. theme patch -----------------------------------------------------
test('theme patch: server edits a theme file -> patched under themes/', async () => {
  const { dir } = makeProject({
    themes: [{ slug: 'thmx', pkg: 'saucal/thmx', version: '1.0.0', body: '.x { color: red; }\n' }],
  });
  const installed = path.join(dir, 'themes/thmx/style.css');
  assert.ok(fs.existsSync(installed), 'theme installed under themes/');

  const serverDir = stageServer(dir, (sv) => {
    const f = path.join(sv, 'themes/thmx/style.css');
    fs.writeFileSync(f, read(f).replace('color: red', 'color: blue'));
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  assert.match(read(installed), /color: blue/, 'theme file patched on disk');
  assert.ok(fs.existsSync(path.join(dir, 'patches/thmx.patch')), 'theme patch file exists');
  const lock = JSON.parse(read(path.join(dir, 'patches.lock.json')));
  assert.ok(lock.patches['saucal/thmx'], 'theme patch lock entry');
  assert.ok(res.applied.includes('patched:thmx:patched'), `applied: ${res.applied}`);
});

// --- 6. already-patched refresh -----------------------------------------
test('already-patched refresh: further server edit -> patch rewritten', async () => {
  // BUILT carries a patch turning "// app code" into "// app code PATCHED-V1".
  const prePatchBody = '// app code\n';
  // Generate a REAL patch (git diff --no-index, rerooted to plugins/patchplug) so
  // composer's patcher can actually apply it during the initial install.
  const pristineContent =
    '<?php\n/**\n * Plugin Name: patchplug\n * Version: 1.0.0\n */\n' + prePatchBody;
  const v1Content = pristineContent.replace('// app code', '// app code PATCHED-V1');
  const tmpPristine = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pristine-'));
  const tmpV1 = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-v1-'));
  fs.writeFileSync(path.join(tmpPristine, 'patchplug.php'), pristineContent);
  fs.writeFileSync(path.join(tmpV1, 'patchplug.php'), v1Content);
  const patchText = generatePatch(tmpPristine, tmpV1, 'plugins/patchplug');

  const { dir } = makeProject({
    plugins: [{ slug: 'patchplug', pkg: 'saucal/patchplug', version: '1.0.0', body: prePatchBody }],
    patches: [
      { pkg: 'saucal/patchplug', slug: 'patchplug', root: 'plugins/patchplug', patchText },
    ],
  });
  const installed = path.join(dir, 'plugins/patchplug/patchplug.php');
  assert.match(read(installed), /PATCHED-V1/, 'built already carries the patch');
  const builtPatchText = read(path.join(dir, 'patches/patchplug.patch'));

  // Server has a FURTHER, different edit on top of the built (patched) state.
  const serverDir = stageServer(dir, (sv) => {
    const f = path.join(sv, 'plugins/patchplug/patchplug.php');
    fs.writeFileSync(f, read(f).replace('PATCHED-V1', 'PATCHED-V2-SERVER'));
  });
  const serverContent = read(path.join(serverDir, 'plugins/patchplug/patchplug.php'));

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  assert.strictEqual(read(installed), serverContent, 'installed now matches full server state');
  assert.notStrictEqual(read(path.join(dir, 'patches/patchplug.patch')), builtPatchText, 'patch rewritten');
  assert.ok(res.applied.includes('patched:patchplug:patched'), `applied: ${res.applied}`);
});

// --- 7. flag-only sensitive ---------------------------------------------
test('flag-only sensitive: server adds a credentials file -> flagged, no change', async () => {
  const { dir } = makeProject({
    plugins: [{ slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' }],
  });
  const composerBefore = read(path.join(dir, 'composer.json'));

  const serverDir = stageServer(dir, (sv) => {
    fs.writeFileSync(
      path.join(sv, 'plugins/baseplug/secret-credentials.php'),
      "<?php return ['key' => 'shh'];\n"
    );
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  const c = findByKey(res.classified, 'baseplug');
  assert.ok(c, 'baseplug component classified');
  assert.strictEqual(c.category, 'sensitive', 'category sensitive');
  assert.strictEqual(c.recoverable, false, 'not recoverable');
  assert.strictEqual(read(path.join(dir, 'composer.json')), composerBefore, 'composer.json unchanged');
  assert.ok(!fs.existsSync(path.join(dir, 'patches', 'baseplug.patch')), 'no patch');
});

// --- 8. flag-only junk --------------------------------------------------
test('flag-only junk: server adds a .log.tick file -> ignorable, no change', async () => {
  const { dir } = makeProject({
    plugins: [{ slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' }],
  });
  const composerBefore = read(path.join(dir, 'composer.json'));

  const serverDir = stageServer(dir, (sv) => {
    const d = path.join(sv, 'plugins/baseplug');
    fs.writeFileSync(path.join(d, 'cron-debug.log.tick'), 'tick\n');
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  const c = findByKey(res.classified, 'baseplug');
  assert.ok(c, 'baseplug classified');
  assert.strictEqual(c.category, 'ignorable', 'category ignorable');
  assert.strictEqual(read(path.join(dir, 'composer.json')), composerBefore, 'composer.json unchanged');
});

// --- 9. mixed -----------------------------------------------------------
test('mixed: add + patch + junk -> all categories, outcome reconciled', async () => {
  const { dir } = makeProject({
    plugins: [
      { slug: 'patchplug', pkg: 'saucal/patchplug', version: '1.0.0', body: '// app code\n' },
      // newplug present as path repo, removed from require for the "add".
      { slug: 'newplug', pkg: 'saucal/newplug', version: '1.0.0', body: '// new plugin\n' },
    ],
  });
  const composerPath = path.join(dir, 'composer.json');
  const composer = JSON.parse(read(composerPath));
  delete composer.require['saucal/newplug'];
  fs.writeFileSync(composerPath, JSON.stringify(composer, null, 4) + '\n');
  const runner = makeRunner();
  let r = await runner.composer(['update', 'saucal/newplug', '-W', '--no-progress'], { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);

  const serverDir = stageServer(dir, (sv) => {
    // add: extra newplug dir
    const np = path.join(sv, 'plugins/newplug');
    fs.mkdirSync(np, { recursive: true });
    fs.writeFileSync(
      path.join(np, 'newplug.php'),
      '<?php\n/**\n * Plugin Name: newplug\n * Version: 1.0.0\n */\n// new plugin\n'
    );
    // patch: edit patchplug
    const pf = path.join(sv, 'plugins/patchplug/patchplug.php');
    fs.writeFileSync(pf, read(pf).replace('// app code', '// app code DRIFTED'));
    // junk: a loose top-level log file (classified independently as ignorable).
    fs.writeFileSync(path.join(sv, 'error.log'), 'oops\n');
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner,
  });

  const cats = res.classified.map((c) => c.category).sort();
  // newplug -> satispress (add); patchplug -> patched-candidate; error.log -> ignorable (loose).
  assert.ok(cats.includes('satispress'), `has add (satispress): ${cats}`);
  assert.ok(cats.includes('patched-candidate'), `has patch: ${cats}`);
  assert.ok(cats.includes('ignorable'), `has junk: ${cats}`);
  assert.strictEqual(res.outcome, 'reconciled', `outcome reconciled: ${res.outcome}`);

  assert.ok(fs.existsSync(path.join(dir, 'plugins/newplug/newplug.php')), 'newplug installed');
  assert.match(read(path.join(dir, 'plugins/patchplug/patchplug.php')), /DRIFTED/, 'patchplug patched');
});

// --- 11. unavailable version --------------------------------------------
test('unavailable: server version exceeds anything published -> flagged, composer.json not broken', async () => {
  // futureplug exists as a path repo at 1.0.0 only; server claims 2.0.0.
  const { dir } = makeProject({
    plugins: [
      { slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' },
      { slug: 'futureplug', pkg: 'saucal/futureplug', version: '1.0.0', body: '// future\n' },
    ],
  });
  const composerPath = path.join(dir, 'composer.json');
  const composer = JSON.parse(read(composerPath));
  delete composer.require['saucal/futureplug'];
  fs.writeFileSync(composerPath, JSON.stringify(composer, null, 4) + '\n');
  const runner = makeRunner();
  let r = await runner.composer(['update', 'saucal/futureplug', '-W', '--no-progress'], { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);
  const composerBefore = read(composerPath);

  // resolver maps futureplug -> package, but the server header (2.0.0) drives the pin.
  const resolvers = {
    async wpackagist() { return null; },
    async satispress(slug) {
      if (slug === 'futureplug') return { source: 'satispress', package: 'saucal/futureplug', version: '1.0.0' };
      return null;
    },
  };

  const serverDir = stageServer(dir, (sv) => {
    const d = path.join(sv, 'plugins/futureplug');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'futureplug.php'),
      '<?php\n/**\n * Plugin Name: futureplug\n * Version: 2.0.0\n */\n// future\n');
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({ sourceDir: dir, treeRoot: serverDir, manifestText, contentDiffText, resolvers, runner });

  const c = findByKey(res.classified, 'futureplug');
  assert.strictEqual(c.category, 'version-unavailable', `category: ${c && c.category}`);
  assert.strictEqual(c.recoverable, false);
  // composer.json is still installable — the unsatisfiable constraint was reverted.
  const after = JSON.parse(read(composerPath));
  assert.ok(!after.require['saucal/futureplug'], 'unavailable add reverted out of require');
  assert.ok(after.require['saucal/baseplug'], 'existing deps preserved');
  assert.strictEqual(read(composerPath), composerBefore, 'composer.json byte-identical to pre-reconcile');
  assert.ok(res.applied.includes('require:saucal/futureplug:unavailable'), `applied: ${res.applied}`);
});

// --- 12. adopt: unresolvable premium plugin vendored into source --------
test('adopt: plugin on neither wpackagist nor SatisPress -> vendored into source (flag on)', async () => {
  const { dir } = makeProject({
    plugins: [{ slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' }],
  });
  // Nothing resolves — the plugin is genuinely unknown to composer (no path repo for it).
  const resolvers = { async wpackagist() { return null; }, async satispress() { return null; } };

  const serverDir = stageServer(dir, (sv) => {
    const d = path.join(sv, 'plugins/premiumx');
    fs.mkdirSync(path.join(d, 'inc'), { recursive: true });
    fs.writeFileSync(path.join(d, 'premiumx.php'), '<?php\n/* Plugin Name: premiumx */\n// premium code\n');
    fs.writeFileSync(path.join(d, 'inc/helper.php'), '<?php // helper\n');
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir, treeRoot: serverDir, manifestText, contentDiffText,
    resolvers, runner: makeRunner(), adopt: true,
  });

  const c = findByKey(res.classified, 'premiumx');
  assert.strictEqual(c.category, 'adopted', `category: ${c && c.category}`);
  assert.ok(fs.existsSync(path.join(dir, 'plugins/premiumx/premiumx.php')), 'vendored main file');
  assert.ok(fs.existsSync(path.join(dir, 'plugins/premiumx/inc/helper.php')), 'vendored nested file');
  assert.ok(res.adoptedPaths.includes('plugins/premiumx'), `adoptedPaths: ${res.adoptedPaths}`);
});

// --- 10. bootstrap cweagans on a repo that lacks it ---------------------
test('bootstrap: repo without cweagans gets it installed + the plugin patched', async () => {
  const { dir } = makeProject({
    noCweagans: true,
    plugins: [{ slug: 'patchplug', pkg: 'saucal/patchplug', version: '1.0.0', body: '// app code\n' }],
  });
  const before = JSON.parse(read(path.join(dir, 'composer.json')));
  assert.ok(!before.require['cweagans/composer-patches'], 'starts without cweagans');

  const installed = path.join(dir, 'plugins/patchplug/patchplug.php');
  const serverDir = stageServer(dir, (sv) => {
    const f = path.join(sv, 'plugins/patchplug/patchplug.php');
    fs.writeFileSync(f, read(f).replace('// app code', '// app code DRIFTED'));
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({
    sourceDir: dir,
    treeRoot: serverDir,
    manifestText,
    contentDiffText,
    resolvers: fakeResolvers,
    runner: makeRunner(),
  });

  const after = JSON.parse(read(path.join(dir, 'composer.json')));
  assert.strictEqual(after.require['cweagans/composer-patches'], '>=2.0.0', 'cweagans added to composer.json');
  assert.ok(res.applied.includes('bootstrap:cweagans'), `applied: ${res.applied}`);
  assert.match(read(installed), /DRIFTED/, 'plugin patched on disk after bootstrap');
  assert.ok(fs.existsSync(path.join(dir, 'patches/patchplug.patch')), 'patch written');
});
