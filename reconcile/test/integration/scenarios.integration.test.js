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
  pinplug: { source: 'satispress', package: 'saucal/pinplug', version: '1.1.0' },
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
    noCweagans: true, // like most fleet repos: a converging bump must not add the patch setup
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

  assert.match(read(installed), /Version: 1\.1\.0/, 'installed bumped to 1.1.0 (the server version, not >=latest)');
  assert.ok(
    res.applied.includes('patched:verplug:bump-only'),
    `patched-candidate resolved bump-only: ${res.applied}`
  );
  assert.ok(!fs.existsSync(path.join(dir, 'patches', 'verplug.patch')), 'no patch written');
  // Patches are a separate pass: a bump that converges must not drag in the patch setup.
  assert.ok(!res.applied.includes('bootstrap:cweagans'), `no cweagans bootstrap for bump-only: ${res.applied}`);
  assert.ok(!JSON.parse(read(path.join(dir, 'composer.json'))).require['cweagans/composer-patches'], 'cweagans not required');
  // The `>=1.0.0` range constraint is NOT bumped — only the lock moves to the server's version.
  const cj = JSON.parse(read(path.join(dir, 'composer.json')));
  assert.strictEqual(cj.require['saucal/verplug'], '>=1.0.0', 'composer.json constraint left unchanged');
  // The PR description says what happened: a version move, not a patch.
  const vc = res.classified.find((c) => c.key === 'verplug');
  assert.strictEqual(vc.category, 'satispress', 'bump-only is reported as a version move');
  assert.match(vc.remediation, /v1\.1\.0 on the server → lock moved to v1\.1\.0 \(the server's files match that release exactly\)/);
  // Verify pass (real composer): the bumped install byte-matches the server's 1.1.0 dir → converges.
  const vp = findByKey(res.classified, 'verplug');
  assert.strictEqual(vp.verified, true, 'bump verifies clean against server');
});

// --- 2b. pinned constraint (do not touch) -------------------------------
test('bump: a pin the server moved past is lifted to >= the server version and installed there', async () => {
  const { dir } = makeProject({
    plugins: [
      { slug: 'pinplug', pkg: 'saucal/pinplug', version: '1.0.0', body: '// v code\n', pin: true },
      { slug: 'pinplug', pkg: 'saucal/pinplug', version: '1.1.0', body: '// v code\n' },
    ],
  });
  const composerBefore = read(path.join(dir, 'composer.json'));
  assert.strictEqual(JSON.parse(composerBefore).require['saucal/pinplug'], '1.0.0', 'starts pinned exact');
  const installed = path.join(dir, 'plugins/pinplug/pinplug.php');
  assert.match(read(installed), /Version: 1\.0\.0/);

  const src111 = path.join(dir, 'pkgs/pinplug-1.1.0');
  const serverDir = stageServer(dir, (sv) => {
    const dst = path.join(sv, 'plugins/pinplug');
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src111)) fs.copyFileSync(path.join(src111, f), path.join(dst, f));
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({ sourceDir: dir, treeRoot: serverDir, manifestText, contentDiffText, resolvers: fakeResolvers, runner: makeRunner() });

  const c = findByKey(res.classified, 'pinplug');
  assert.strictEqual(c.recoverable, true);
  assert.deepStrictEqual(c.constraintRelaxed, { from: '1.0.0', to: '>=1.1.0' });
  assert.strictEqual(JSON.parse(read(path.join(dir, 'composer.json'))).require['saucal/pinplug'], '>=1.1.0', 'pin lifted');
  assert.match(read(installed), /Version: 1\.1\.0/, 'installed at the server version');
  assert.strictEqual(JSON.parse(read(path.join(dir, 'composer.lock'))).packages.find((p) => p.name === 'saucal/pinplug').version, '1.1.0');
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
    // A binary file too: patches are cut with --binary, and cweagans must apply that hunk.
    fs.writeFileSync(path.join(sv, 'plugins/patchplug/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]));
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
  assert.ok(fs.readFileSync(path.join(dir, 'plugins/patchplug/logo.png')).equals(fs.readFileSync(path.join(serverDir, 'plugins/patchplug/logo.png'))), 'binary file applied');
  assert.strictEqual(findByKey(res.classified, 'patchplug').verified, true);
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
    // add: newplug exactly as published (byte-identical to the package), so it is a clean add.
    // A server copy that differs from the published one would rightly go to the patch pass.
    const np = path.join(sv, 'plugins/newplug');
    fs.rmSync(np, { recursive: true, force: true });
    fs.mkdirSync(np, { recursive: true });
    const pub = path.join(dir, 'pkgs/newplug-1.0.0');
    for (const f of fs.readdirSync(pub)) fs.copyFileSync(path.join(pub, f), path.join(np, f));
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
test('unavailable: server version exceeds anything published -> newest published pinned, bridge patch', async () => {
  // futureplug exists as a path repo at 1.0.0 only; server runs 2.0.0 (no registry has it).
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
  const r = await runner.composer(['update', 'saucal/futureplug', '-W', '--no-progress'], { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);

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
      '<?php\n/**\n * Plugin Name: futureplug\n * Version: 2.0.0\n */\n// future, two\n');
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({ sourceDir: dir, treeRoot: serverDir, manifestText, contentDiffText, resolvers, runner });

  const c = findByKey(res.classified, 'futureplug');
  assert.deepStrictEqual(c.bridged, { from: '1.0.0', to: '2.0.0' }, `${c.category}: ${c.remediation} | ${res.applied}`);
  assert.strictEqual(c.recoverable, true);
  assert.strictEqual(c.verified, true, 'the bridged install matches the server');
  const after = JSON.parse(read(composerPath));
  assert.strictEqual(after.require['saucal/futureplug'], '1.0.0', 'base pinned exactly');
  // The server also changed a code line ('// future' → '// future, two'): named, not passed off as a version bump.
  assert.match(after.extra.patches['saucal/futureplug'][0].description, /^Bridges v1\.0\.0 → v2\.0\.0 \+ local edits \(\d+ lines\)/);
  assert.match(c.remediation, /with local edits \(\d+ lines in [^)]*plugins\/futureplug\/futureplug\.php[^)]*\) plus the version bump to v2\.0\.0.*Lifting the pin drops those edits/);
  assert.ok(res.applied.includes('require:saucal/futureplug:bridge-base'), `applied: ${res.applied}`);
  assert.ok(res.autoMerge.reasons.some((x) => /^futureplug: bridges to v2\.0\.0 and carries \d+ lines of local edits in .*futureplug\.php — review$/.test(x)), `held: ${res.autoMerge.reasons}`);
  assert.strictEqual((await runner.composer(['validate', '--no-check-all', '--no-check-publish', '--check-lock'], { cwd: dir })).code, 0, 'lock in sync');
});

test('bridge then rematch: an unparseable server header is bridged; a later release on the server lifts the pin and drops the patch', async () => {
  const { dir } = makeProject({
    plugins: [
      { slug: 'devplug', pkg: 'saucal/devplug', version: '1.0.0', body: '// one\n' },
      { slug: 'devplug', pkg: 'saucal/devplug', version: '2.0.0', body: '// two\n' },
    ],
  });
  const runner = makeRunner();
  const composerPath = path.join(dir, 'composer.json');
  const resolvers = {
    async wpackagist() { return null; },
    async satispress(slug) { return slug === 'devplug' ? { source: 'satispress', package: 'saucal/devplug', version: '1.0.0' } : null; },
  };

  // 1. The server runs 2.0.0-dev2: composer can't parse it, so classify pins the published 1.0.0.
  const dev = stageServer(dir, (sv) => {
    fs.writeFileSync(path.join(sv, 'plugins/devplug/devplug.php'),
      '<?php\n/**\n * Plugin Name: devplug\n * Version: 2.0.0-dev2\n */\n// two, almost\n');
  });
  let drift = deriveDrift(dir, dev);
  let res = await reconcileRun({ sourceDir: dir, treeRoot: dev, ...drift, resolvers, runner });
  let c = findByKey(res.classified, 'devplug');
  assert.deepStrictEqual(c.bridged, { from: '1.0.0', to: '2.0.0-dev2' }, `${c.category}: ${c.remediation} | ${res.applied}`);
  assert.strictEqual(c.verified, true);
  assert.strictEqual(JSON.parse(read(composerPath)).require['saucal/devplug'], '1.0.0');

  // 2. The server moves to the 2.0.0 release: the pin is lifted, the bridge patch dropped.
  const rel = stageServer(dir, (sv) => {
    // The whole release replaces the plugin (its composer.json says 2.0.0 too).
    fs.rmSync(path.join(sv, 'plugins/devplug'), { recursive: true });
    fs.cpSync(path.join(dir, 'pkgs/devplug-2.0.0'), path.join(sv, 'plugins/devplug'), { recursive: true });
  });
  drift = deriveDrift(dir, rel);
  res = await reconcileRun({ sourceDir: dir, treeRoot: rel, ...drift, resolvers, runner });
  c = findByKey(res.classified, 'devplug');
  assert.ok(res.applied.includes('bridge-dropped:saucal/devplug'), `applied: ${res.applied}`);
  assert.ok(!c.bridged && !c.patchFile, `${c.category}: ${c.remediation}`);
  assert.strictEqual(c.verified, true);
  const after = JSON.parse(read(composerPath));
  assert.strictEqual(after.require['saucal/devplug'], '>=2.0.0', 'pin lifted to the release');
  assert.ok(!(after.extra.patches && after.extra.patches['saucal/devplug']), 'bridge patch dropped');
  assert.ok(!fs.existsSync(path.join(dir, 'patches/devplug.patch')), 'patch file removed');
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
  // Verify pass: the vendored copy reproduces the server exactly.
  assert.strictEqual(c.verified, true, 'adopted plugin verifies clean against server');
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
  assert.strictEqual(after.require['saucal/composer-patches'], '>=1.1.0', 'saucal/composer-patches added to composer.json');
  const locked = JSON.parse(read(path.join(dir, 'composer.lock'))).packages.map((p) => p.name);
  assert.ok(locked.includes('cweagans/composer-patches'), 'cweagans locked as its dependency');
  assert.ok(res.applied.includes('bootstrap:cweagans'), `applied: ${res.applied}`);
  assert.match(read(installed), /DRIFTED/, 'plugin patched on disk after bootstrap');
  assert.ok(fs.existsSync(path.join(dir, 'patches/patchplug.patch')), 'patch written');
});

// --- update + residual edits (e.g. repo on product-bundles 8.5.9, server on 9.1.0 + FTP edits) ---
test('update + patch: newer version on server with edits -> lock moves, residual becomes a patch', async () => {
  const { dir } = makeProject({
    noCweagans: true,
    plugins: [
      { slug: 'verplug', pkg: 'saucal/verplug', version: '1.0.0', body: '// v code\n' },
      { slug: 'verplug', pkg: 'saucal/verplug', version: '1.1.0', body: '// v code\n' },
    ],
  });
  // Server: the published 1.1.0, then an edit on top; one file also chmod'ed (not drift).
  const pub = path.join(dir, 'pkgs/verplug-1.1.0');
  const serverDir = stageServer(dir, (sv) => {
    const dst = path.join(sv, 'plugins/verplug');
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(pub)) fs.copyFileSync(path.join(pub, f), path.join(dst, f));
    const main = path.join(dst, 'verplug.php');
    fs.writeFileSync(main, read(main).replace('// v code', '// v code + hotfix on production'));
    fs.chmodSync(path.join(dst, 'composer.json'), 0o755);
  });

  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({ sourceDir: dir, treeRoot: serverDir, manifestText, contentDiffText, resolvers: fakeResolvers, runner: makeRunner() });

  const lock = JSON.parse(read(path.join(dir, 'composer.lock')));
  assert.strictEqual(lock.packages.find((p) => p.name === 'saucal/verplug').version, '1.1.0', 'lock follows the server version');
  assert.ok(res.applied.includes('patched:verplug:patched'), res.applied.join(','));
  assert.ok(res.applied.includes('bootstrap:cweagans'), 'patch tooling added because a real patch exists');
  const patch = read(path.join(dir, 'patches/verplug.patch'));
  assert.match(patch, /\+.*hotfix on production/);
  assert.doesNotMatch(patch, /composer\.json|mode/, 'the chmod-only file is not in the patch');
  assert.match(read(path.join(dir, 'plugins/verplug/verplug.php')), /hotfix on production/, 'patch applied on install');
  assert.ok(res.autoMerge.ok, res.autoMerge.reasons.join(' | '));
});

// --- adopted root under an ignored parent gains a new file on the server --------
test('tracked root under a gitignored plugins/: a new server file git refuses is named as needing a decision, not reported as carried', async () => {
  const { stageOutputs } = require('../../lib/stage');
  const { execFileSync } = require('child_process');
  const { dir } = makeProject({
    plugins: [{ slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' }],
  });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  // plugins/* ignored with no re-include for the custom plugin: an earlier adoption force-added it.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'vendor/\npkgs/\nplugins/*\n');
  fs.mkdirSync(path.join(dir, 'plugins/customx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugins/customx/customx.php'), '<?php\n/* Plugin Name: customx */\n');
  git('init', '-q');
  git('add', '-A');
  git('add', '-f', '--', 'plugins/customx');
  git('commit', '-q', '-m', 'init');

  const serverDir = stageServer(dir, (sv) => {
    fs.mkdirSync(path.join(sv, 'plugins/customx/assets'), { recursive: true });
    fs.writeFileSync(path.join(sv, 'plugins/customx/assets/blob.bin'), Buffer.from([0, 1, 2, 3]));
  });
  const files = new Set(git('ls-files').split('\n').filter(Boolean));
  const isTracked = (p) => files.has(p) || [...files].some((f) => f.startsWith(`${p}/`));
  const { manifestText, contentDiffText } = deriveDrift(dir, serverDir);
  const res = await reconcileRun({ sourceDir: dir, treeRoot: serverDir, manifestText, contentDiffText, resolvers: fakeResolvers, runner: makeRunner(), isTracked });

  const c = findByKey(res.classified, 'customx');
  assert.strictEqual(c.category, 'tracked', `category: ${c && c.category}`);
  const staged = await stageOutputs(dir, res, isTracked, async (args) => {
    try { return { code: 0, out: git(...args) }; } catch (e) { return { code: e.status || 1, out: `${e.stdout || ''}${e.stderr || ''}` }; }
  });
  assert.ok(!staged.includes('plugins/customx/assets/blob.bin'), `staged: ${staged}`);
  assert.strictEqual(c.recoverable, false);
  assert.match(c.remediation, /could not be staged.*ignored/);
  const { remaining, reportBody } = require('../../lib/report');
  assert.strictEqual(remaining(res.classified), '1 item(s) need a decision');
  const body = reportBody(res.classified, { ref: 'main', runUrl: 'u', already: true });
  assert.doesNotMatch(body, /next Deploy ships them/);
  assert.match(body, /`customx` — .*could not be staged/);
});
