'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reconcilePatched } = require('../lib/reconcile-patched');

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
