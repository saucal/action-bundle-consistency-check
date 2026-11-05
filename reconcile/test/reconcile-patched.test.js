'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { reconcilePatched, dropPatches } = require('../lib/reconcile-patched');

function mkdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/**
 * Build a fake runner that records composer calls. For `reinstall`, it copies a
 * pristine file into the installed plugin dir (simulating composer restoring
 * published files). Hermetic — no real composer.
 */
function makeFakeRunner({ projectDir, slug, pristineFiles }) {
  const calls = [];
  return {
    calls,
    composer(args, opts) {
      calls.push(args.join(' '));
      if (args[0] === 'reinstall') {
        const installedDir = path.join(projectDir, 'plugins', slug);
        fs.mkdirSync(installedDir, { recursive: true });
        for (const [name, content] of Object.entries(pristineFiles)) {
          fs.writeFileSync(path.join(installedDir, name), content);
        }
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

function scaffoldProject() {
  const projectDir = mkdir('proj-');
  fs.writeFileSync(
    path.join(projectDir, 'composer.json'),
    JSON.stringify({ name: 'test/proj', require: { 'saucal/fakeplug': '^1.0' } }, null, 4) + '\n'
  );
  return projectDir;
}

test('reconcilePatched: server differs -> writes patch, registers extra.patches, relock then repatch, action patched', async () => {
  const projectDir = scaffoldProject();
  const slug = 'fakeplug';
  const pkg = 'saucal/fakeplug';
  const pristineFiles = { 'fakeplug.php': "<?php\n// original line\n" };

  // serverDir holds the drifted copy: same file with one line edited.
  const serverDir = mkdir('server-');
  fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), "<?php\n// edited line\n");

  const runner = makeFakeRunner({ projectDir, slug, pristineFiles });
  const res = await reconcilePatched({ projectDir, slug, pkg, serverDir, runner });

  assert.strictEqual(res.action, 'patched');
  assert.strictEqual(res.patchFile, './patches/fakeplug.patch');

  // Patch file written.
  const patchPath = path.join(projectDir, 'patches', 'fakeplug.patch');
  assert.ok(fs.existsSync(patchPath), 'patch file should exist');
  const patch = fs.readFileSync(patchPath, 'utf8');
  assert.match(patch, /^diff --git plugins\/fakeplug\/fakeplug\.php/m);
  assert.match(patch, /-\/\/ original line/);
  assert.match(patch, /\+\/\/ edited line/);

  // extra.patches registered.
  const composer = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8'));
  assert.ok(composer.extra && composer.extra.patches && composer.extra.patches[pkg], 'extra.patches entry');
  assert.strictEqual(composer.extra.patches[pkg][0].url, './patches/fakeplug.patch');
  assert.strictEqual(composer.extra.patches[pkg][0].depth, 2);

  // Call ordering: reinstall first, then relock before repatch.
  assert.strictEqual(runner.calls[0].split(' ')[0], 'reinstall');
  const relockIdx = runner.calls.findIndex((c) => c.startsWith('patches-relock'));
  const repatchIdx = runner.calls.findIndex((c) => c.startsWith('patches-repatch'));
  assert.ok(relockIdx !== -1 && repatchIdx !== -1, 'both relock and repatch called');
  assert.ok(relockIdx < repatchIdx, 'relock must precede repatch');
});

test('reconcilePatched: server == pristine -> action bump-only, no patch, no relock/repatch', async () => {
  const projectDir = scaffoldProject();
  const slug = 'fakeplug';
  const pkg = 'saucal/fakeplug';
  const pristineFiles = { 'fakeplug.php': "<?php\n// original line\n" };

  // serverDir identical to pristine.
  const serverDir = mkdir('server-');
  fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), "<?php\n// original line\n");

  const runner = makeFakeRunner({ projectDir, slug, pristineFiles });
  const res = await reconcilePatched({ projectDir, slug, pkg, serverDir, runner });

  assert.strictEqual(res.action, 'bump-only');
  assert.strictEqual(res.patchFile, undefined);
  assert.ok(!fs.existsSync(path.join(projectDir, 'patches', 'fakeplug.patch')), 'no patch file');

  const composer = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8'));
  assert.ok(!(composer.extra && composer.extra.patches), 'no extra.patches');

  assert.ok(!runner.calls.some((c) => c.startsWith('patches-relock')), 'no relock');
  assert.ok(!runner.calls.some((c) => c.startsWith('patches-repatch')), 'no repatch');
});

test('reconcilePatched: header versions differ after the pristine reinstall -> no patch across versions', async () => {
  const projectDir = scaffoldProject();
  const serverDir = mkdir('server-');
  fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), "<?php\n/* Plugin Name: Fake\n * Version: 1.0.1 */\n// edited\n");
  const runner = makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles: { 'fakeplug.php': "<?php\n/* Plugin Name: Fake\n * Version: 1.0.0 */\n" } });
  const res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, runner });
  assert.strictEqual(res.action, 'version-mismatch');
  assert.deepStrictEqual([res.installed, res.server], ['1.0.0', '1.0.1']);
  assert.ok(!fs.existsSync(path.join(projectDir, 'patches', 'fakeplug.patch')), 'no patch written');
});

test('reconcilePatched: a version gap is a mismatch, unless allowed: then a marked bridge patch', async () => {
  const pristineFiles = { 'fakeplug.php': '<?php\n/**\n * Plugin Name: fakeplug\n * Version: 1.0.0\n */\n' };
  const serverDir = mkdir('server-');
  fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), '<?php\n/**\n * Plugin Name: fakeplug\n * Version: 2.0.0-dev2\n */\n');

  let projectDir = scaffoldProject();
  let res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, runner: makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles }) });
  assert.deepStrictEqual(res, { action: 'version-mismatch', installed: '1.0.0', server: '2.0.0-dev2' });

  projectDir = scaffoldProject();
  res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, allowVersionGap: true, runner: makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles }) });
  assert.strictEqual(res.action, 'bridged');
  const entry = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8')).extra.patches['saucal/fakeplug'][0];
  assert.match(entry.description, /^Bridges v1\.0\.0 → v2\.0\.0-dev2/);
});

test('reconcilePatched: a bridge that also carries code names its local edits; a header-only one does not', async () => {
  const pristineFiles = { 'fakeplug.php': '<?php\n/**\n * Plugin Name: fakeplug\n * Version: 1.0.0\n */\n' };
  const run = async (serverText) => {
    const serverDir = mkdir('server-');
    fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), serverText);
    const projectDir = scaffoldProject();
    const res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, allowVersionGap: true, runner: makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles }) });
    return { res, entry: JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8')).extra.patches['saucal/fakeplug'][0] };
  };

  let { res, entry } = await run('<?php\n/**\n * Plugin Name: fakeplug\n * Version: 1.0.1\n */\nfix_one();\nfix_two();\n');
  assert.strictEqual(res.action, 'bridged');
  assert.deepStrictEqual(res.localEdits, { lines: 2, files: ['plugins/fakeplug/fakeplug.php'] });
  assert.strictEqual(entry.description, 'Bridges v1.0.0 → v1.0.1 + local edits (2 lines) (no published release has it)');

  ({ res, entry } = await run('<?php\n/**\n * Plugin Name: fakeplug\n * Version: 1.0.1\n */\nfix_one();\n'));
  assert.strictEqual(entry.description, 'Bridges v1.0.0 → v1.0.1 + local edits (1 line) (no published release has it)');

  ({ res, entry } = await run('<?php\n/**\n * Plugin Name: fakeplug\n * Version: 1.0.1\n */\n'));
  assert.deepStrictEqual(res.localEdits, { lines: 0, files: [] });
  assert.strictEqual(entry.description, 'Bridges v1.0.0 → v1.0.1 (no published release has it)');
});

// A developer patch (any name but the heal's patches/<slug>.patch) stays, first; the heal's goes after it.
function devScaffold(withHeal) {
  const projectDir = scaffoldProject();
  const c = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8'));
  fs.mkdirSync(path.join(projectDir, 'patches'));
  const dev = 'diff --git plugins/fakeplug/fakeplug.php plugins/fakeplug/fakeplug.php\n--- plugins/fakeplug/fakeplug.php\n+++ plugins/fakeplug/fakeplug.php\n@@ -1,3 +1,3 @@\n <?php\n-// one\n+// one DEV\n // two\n';
  fs.writeFileSync(path.join(projectDir, 'patches/fakeplug-dev.patch'), dev);
  c.extra = { patches: { 'saucal/fakeplug': [{ description: 'Developer fix', url: './patches/fakeplug-dev.patch', depth: 2 }] } };
  if (withHeal) {
    fs.writeFileSync(path.join(projectDir, 'patches/fakeplug.patch'), 'old heal patch\n');
    c.extra.patches['saucal/fakeplug'].push({ description: 'Reconciled from server drift for fakeplug', url: './patches/fakeplug.patch', depth: 2 });
  }
  fs.writeFileSync(path.join(projectDir, 'composer.json'), JSON.stringify(c, null, 4) + '\n');
  return { projectDir, dev };
}
const STOCK_PLUS_DEV = { 'fakeplug.php': '<?php\n// one DEV\n// two\n// three\n' };

test('reconcilePatched: a developer patch is kept and the heal patch is cut on top of it, after it', async () => {
  for (const withHeal of [false, true]) {
    const { projectDir, dev } = devScaffold(withHeal);
    const serverDir = mkdir('server-');
    fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), '<?php\n// one DEV\n// two\n// three SERVER\n');
    const runner = makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles: STOCK_PLUS_DEV });
    const realRepatch = runner.composer;
    runner.composer = (args, opts) => { // repatch = cweagans applying both patches: the server's copy
      if (args[0] === 'patches-repatch') fs.copyFileSync(path.join(serverDir, 'fakeplug.php'), path.join(projectDir, 'plugins/fakeplug/fakeplug.php'));
      return realRepatch(args, opts);
    };
    const res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, runner });

    assert.strictEqual(res.action, 'patched');
    assert.deepStrictEqual(res.kept, ['./patches/fakeplug-dev.patch']);
    const entries = JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8')).extra.patches['saucal/fakeplug'];
    assert.deepStrictEqual(entries.map((e) => e.url), ['./patches/fakeplug-dev.patch', './patches/fakeplug.patch']);
    assert.strictEqual(entries[0].description, 'Developer fix');
    assert.strictEqual(fs.readFileSync(path.join(projectDir, 'patches/fakeplug-dev.patch'), 'utf8'), dev);
    const heal = fs.readFileSync(path.join(projectDir, 'patches/fakeplug.patch'), 'utf8');
    assert.match(heal, /^-\/\/ three$/m);
    assert.doesNotMatch(heal, /^[-+]\/\/ one/m, 'the heal patch is relative to stock + the developer patch');
  }
});

test('reconcilePatched: the server undid a developer patch -> needs-resolution, nothing touched (also inside a git repo)', async () => {
  const { projectDir } = devScaffold(true);
  const composerBefore = fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8');
  const repo = mkdir('built-');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const serverDir = path.join(repo, 'plugins/fakeplug');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), '<?php\n// one\n// two\n// three\n');
  const runner = makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles: STOCK_PLUS_DEV });
  const res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, runner });

  assert.strictEqual(res.action, 'needs-resolution');
  assert.deepStrictEqual(res.patches, ['./patches/fakeplug-dev.patch']);
  assert.strictEqual(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8'), composerBefore);
  assert.strictEqual(fs.readFileSync(path.join(projectDir, 'patches/fakeplug.patch'), 'utf8'), 'old heal patch\n');
  assert.deepStrictEqual(runner.calls, []);
});

test('reconcilePatched: a developer patch that no longer applies on reinstall -> needs-resolution, the earlier heal patch put back', async () => {
  const { projectDir } = devScaffold(true);
  const composerBefore = fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8');
  const serverDir = mkdir('server-');
  fs.writeFileSync(path.join(serverDir, 'fakeplug.php'), '<?php\n// one DEV\n// two\n// three SERVER\n');
  const runner = makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles: STOCK_PLUS_DEV });
  const fake = runner.composer;
  let first = true;
  runner.composer = (args, opts) => {
    if (args[0] === 'reinstall' && first) { first = false; runner.calls.push(args.join(' ')); return Promise.resolve({ code: 1, stdout: '', stderr: 'No available patcher' }); }
    return fake(args, opts);
  };
  const res = await reconcilePatched({ projectDir, slug: 'fakeplug', pkg: 'saucal/fakeplug', serverDir, runner });

  assert.strictEqual(res.action, 'needs-resolution');
  assert.deepStrictEqual(res.patches, ['./patches/fakeplug-dev.patch']);
  assert.strictEqual(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8'), composerBefore);
  assert.strictEqual(fs.readFileSync(path.join(projectDir, 'patches/fakeplug.patch'), 'utf8'), 'old heal patch\n');
});

test('dropPatches: drops only the heal patch, never a developer one', async () => {
  const { projectDir, dev } = devScaffold(true);
  const runner = makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles: {} });
  const removed = await dropPatches(projectDir, 'saucal/fakeplug', runner, 'fakeplug');
  assert.deepStrictEqual(removed.map((e) => e.url), ['./patches/fakeplug.patch']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(projectDir, 'composer.json'), 'utf8')).extra.patches['saucal/fakeplug'].map((e) => e.url), ['./patches/fakeplug-dev.patch']);
  assert.strictEqual(fs.readFileSync(path.join(projectDir, 'patches/fakeplug-dev.patch'), 'utf8'), dev);
  assert.ok(!fs.existsSync(path.join(projectDir, 'patches/fakeplug.patch')));
  // a developer patch alone: nothing to drop, no relock
  const again = makeFakeRunner({ projectDir, slug: 'fakeplug', pristineFiles: {} });
  assert.deepStrictEqual(await dropPatches(projectDir, 'saucal/fakeplug', again, 'fakeplug'), []);
  assert.deepStrictEqual(again.calls, []);
});
