'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeProject } = require('../helpers/make-project');
const { upsertRequire } = require('../../lib/composer');
const { reconcilePatched } = require('../../lib/reconcile-patched');

function mkServerCopy(installedDir, mutate) {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-'));
  for (const name of fs.readdirSync(installedDir)) {
    let content = fs.readFileSync(path.join(installedDir, name), 'utf8');
    if (mutate) content = mutate(name, content);
    fs.writeFileSync(path.join(serverDir, name), content);
  }
  return serverDir;
}

// --- add ----------------------------------------------------------------
test('add: requiring a new package installs it under plugins/', async () => {
  // newplug exists as a path repo but is NOT required initially.
  const { dir, runner } = makeProject({
    plugins: [
      { slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' },
      // present as path repo, removed from require below
      { slug: 'newplug', pkg: 'saucal/newplug', version: '1.0.0', body: '// new\n' },
    ],
  });

  const composerPath = path.join(dir, 'composer.json');
  const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
  // Remove newplug so the project starts WITHOUT it installed.
  delete composer.require['saucal/newplug'];
  fs.writeFileSync(composerPath, JSON.stringify(composer, null, 4) + '\n');
  let r = await runner.composer(['update', 'saucal/newplug', '--no-progress'], { cwd: dir });
  // (update of a non-required pkg is a no-op; just ensures lock is consistent)
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'plugins/newplug')), 'newplug not installed yet');

  // Now upsertRequire newplug + composer update.
  const next = upsertRequire(JSON.parse(fs.readFileSync(composerPath, 'utf8')), 'saucal/newplug', '1.0.0').composer;
  fs.writeFileSync(composerPath, JSON.stringify(next, null, 4) + '\n');
  r = await runner.composer(['update', 'saucal/newplug', '--no-progress'], { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);

  assert.ok(fs.existsSync(path.join(dir, 'plugins/newplug/newplug.php')), 'newplug.php should exist');
});

// --- bump ---------------------------------------------------------------
test('bump: bumping the constraint installs the newer version', async () => {
  const { dir, runner } = makeProject({
    plugins: [
      { slug: 'bumpplug', pkg: 'saucal/bumpplug', version: '1.0.0', body: '// v1\n' },
      { slug: 'bumpplug', pkg: 'saucal/bumpplug', version: '1.1.0', body: '// v1.1\n' },
    ],
  });
  const installed = path.join(dir, 'plugins/bumpplug/bumpplug.php');
  assert.match(fs.readFileSync(installed, 'utf8'), /Version: 1\.0\.0/);

  const composerPath = path.join(dir, 'composer.json');
  const next = upsertRequire(JSON.parse(fs.readFileSync(composerPath, 'utf8')), 'saucal/bumpplug', '>=1.1.0').composer;
  fs.writeFileSync(composerPath, JSON.stringify(next, null, 4) + '\n');
  const r = await runner.composer(['update', 'saucal/bumpplug', '-W', '--no-progress'], { cwd: dir });
  assert.strictEqual(r.code, 0, r.stderr);

  assert.match(fs.readFileSync(installed, 'utf8'), /Version: 1\.1\.0/, 'should be bumped to 1.1.0');
});

// --- patch (modified-from-published) ------------------------------------
test('patch: server drift becomes a real composer patch applied on disk', async () => {
  const { dir, runner } = makeProject({
    plugins: [{ slug: 'patchplug', pkg: 'saucal/patchplug', version: '1.0.0', body: '// app code\n' }],
  });
  const installedDir = path.join(dir, 'plugins/patchplug');
  const installedFile = path.join(installedDir, 'patchplug.php');

  // serverDir = pristine with one line edited.
  const serverDir = mkServerCopy(installedDir, (name, content) =>
    name === 'patchplug.php' ? content.replace('// app code', '// app code DRIFTED') : content
  );

  const res = await reconcilePatched({
    projectDir: dir,
    slug: 'patchplug',
    pkg: 'saucal/patchplug',
    serverDir,
    runner,
  });

  assert.strictEqual(res.action, 'patched');
  assert.match(fs.readFileSync(installedFile, 'utf8'), /\/\/ app code DRIFTED/, 'patch applied on disk');

  const lockPath = path.join(dir, 'patches.lock.json');
  assert.ok(fs.existsSync(lockPath), 'patches.lock.json exists');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const entries = lock.patches['saucal/patchplug'];
  assert.ok(Array.isArray(entries) && entries.length === 1, 'one patch entry for pkg');
  assert.ok(typeof entries[0].sha256 === 'string' && entries[0].sha256.length > 0, 'entry has sha256');
});

// --- stale (no residual) ------------------------------------------------
test('stale: server == pristine yields bump-only with no patch written', async () => {
  const { dir, runner } = makeProject({
    plugins: [{ slug: 'staleplug', pkg: 'saucal/staleplug', version: '1.0.0', body: '// app code\n' }],
  });
  const installedDir = path.join(dir, 'plugins/staleplug');

  // serverDir identical to pristine.
  const serverDir = mkServerCopy(installedDir, null);

  const res = await reconcilePatched({
    projectDir: dir,
    slug: 'staleplug',
    pkg: 'saucal/staleplug',
    serverDir,
    runner,
  });

  assert.strictEqual(res.action, 'bump-only');
  assert.ok(!fs.existsSync(path.join(dir, 'patches', 'staleplug.patch')), 'no patch file written');

  const lockPath = path.join(dir, 'patches.lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const patches = lock.patches || {};
    assert.ok(Object.keys(patches).length === 0, 'patches.lock.json patches empty');
  }
});

// --- re-cut keeps key order -----------------------------------------------
test('re-cut: refreshing the middle package keeps extra.patches and patches.lock.json order', async () => {
  const { generatePatch } = require('../../lib/patch-gen');
  const slugs = ['aplug', 'bplug', 'cplug'];
  const pristine = (s) => `<?php\n/**\n * Plugin Name: ${s}\n * Version: 1.0.0\n */\n// app code\n`;
  const patches = slugs.map((slug) => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ko-b-'));
    fs.writeFileSync(path.join(a, `${slug}.php`), pristine(slug));
    fs.writeFileSync(path.join(b, `${slug}.php`), pristine(slug).replace('// app code', '// app code V1'));
    return { pkg: `saucal/${slug}`, slug, root: `plugins/${slug}`, patchText: generatePatch(a, b, `plugins/${slug}`) };
  });
  const { dir, runner } = makeProject({
    plugins: slugs.map((slug) => ({ slug, pkg: `saucal/${slug}`, version: '1.0.0', body: '// app code\n' })),
    patches,
  });
  const order = slugs.map((s) => `saucal/${s}`);
  const lockKeys = () => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'patches.lock.json'), 'utf8')).patches);
  assert.deepStrictEqual(lockKeys(), order, 'baseline lock order');

  const serverDir = mkServerCopy(path.join(dir, 'plugins/bplug'), (name, c) => c.replace('// app code V1', '// app code V2'));
  const res = await reconcilePatched({ projectDir: dir, slug: 'bplug', pkg: 'saucal/bplug', serverDir, runner });

  assert.strictEqual(res.action, 'patched');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'composer.json'), 'utf8')).extra.patches), order);
  assert.deepStrictEqual(lockKeys(), order);
});
