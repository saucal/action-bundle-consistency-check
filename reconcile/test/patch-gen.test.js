'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generatePatch, upsertExtraPatches } = require('../lib/patch-gen');

function mkdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('generatePatch emits a unified diff rooted at the plugin path', () => {
  const pristine = mkdir('pristine-');
  const server = mkdir('server-');
  fs.writeFileSync(path.join(pristine, 'tooltips.php'), "<?php\n$wp_rewrite->flush_rules();\n");
  fs.writeFileSync(path.join(server, 'tooltips.php'), "<?php\n// disabled\n");
  const patch = generatePatch(pristine, server, 'plugins/tooltips-pro');
  assert.match(patch, /^diff --git plugins\/tooltips-pro\/tooltips\.php plugins\/tooltips-pro\/tooltips\.php$/m);
  assert.match(patch, /^--- plugins\/tooltips-pro\/tooltips\.php/m);
  assert.match(patch, /^\+\+\+ plugins\/tooltips-pro\/tooltips\.php/m);
  assert.match(patch, /-\$wp_rewrite->flush_rules\(\);/);
  assert.match(patch, /\+\/\/ disabled/);
});

test('generatePatch returns empty string when dirs match', () => {
  const a = mkdir('a-'); const b = mkdir('b-');
  fs.writeFileSync(path.join(a, 'x.php'), 'same\n');
  fs.writeFileSync(path.join(b, 'x.php'), 'same\n');
  assert.strictEqual(generatePatch(a, b, 'plugins/x'), '');
});

test('upsertExtraPatches adds an entry and reports changed; immutable input', () => {
  const base = { name: 'x/y' };
  const entry = { description: 'Custom patch', url: './patches/tooltips-pro.patch', depth: 2 };
  const { composer, changed } = upsertExtraPatches(base, 'saucal/tooltips-pro', entry);
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(composer.extra.patches['saucal/tooltips-pro'], [entry]);
  assert.strictEqual(base.extra, undefined); // input untouched
});

test('upsertExtraPatches is a no-op when the same entry already present', () => {
  const entry = { description: 'd', url: './patches/p.patch', depth: 2 };
  const base = { extra: { patches: { 'saucal/p': [entry] } } };
  const { changed } = upsertExtraPatches(base, 'saucal/p', entry);
  assert.strictEqual(changed, false);
});

test('generatePatch ignores file-mode-only differences (a chmod is not drift)', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-b-'));
  for (const d of [a, b]) { fs.writeFileSync(path.join(d, 'x.php'), '<?php // same\n'); fs.writeFileSync(path.join(d, 'y.php'), '<?php // v1\n'); }
  fs.chmodSync(path.join(b, 'x.php'), 0o755);
  assert.strictEqual(generatePatch(a, b, 'plugins/p'), '', 'mode-only -> no patch');

  fs.writeFileSync(path.join(b, 'y.php'), '<?php // v2\n');
  fs.chmodSync(path.join(b, 'y.php'), 0o755);
  const patch = generatePatch(a, b, 'plugins/p');
  assert.match(patch, /\+<\?php \/\/ v2/);
  assert.doesNotMatch(patch, /x\.php/, 'the chmod-only file is dropped');
  assert.doesNotMatch(patch, /^(?:old|new) mode/m, 'no mode lines (cweagans/patch would choke or chmod)');
});

test('a moved file is a delete plus an add, so the patch applies (rename headers carried the temp paths)', () => {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  const pristine = path.join(tmp, 'source/plugins/x');
  const server = path.join(tmp, 'built/plugins/x');
  const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.mkdirSync(path.join(pristine, 'vendor'), { recursive: true });
  fs.mkdirSync(server, { recursive: true });
  fs.writeFileSync(path.join(pristine, 'vendor/LICENSE'), body);
  fs.writeFileSync(path.join(server, 'LICENSE.txt'), body.replace('line 39', 'line 39!'));

  const patch = generatePatch(pristine, server, 'plugins/x');
  assert.doesNotMatch(patch, /^(rename|copy) (from|to) /m);
  assert.doesNotMatch(patch, /source\/|built\//);

  // It applies to a copy of the pristine tree, rooted where cweagans applies it (depth 2).
  const work = path.join(tmp, 'work');
  fs.mkdirSync(path.join(work, 'plugins'), { recursive: true });
  fs.cpSync(pristine, path.join(work, 'plugins/x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'p.patch'), patch);
  execFileSync('git', ['apply', '-p0', path.join(tmp, 'p.patch')], { cwd: work });
  assert.strictEqual(fs.readFileSync(path.join(work, 'plugins/x/LICENSE.txt'), 'utf8'), fs.readFileSync(path.join(server, 'LICENSE.txt'), 'utf8'));
  assert.ok(!fs.existsSync(path.join(work, 'plugins/x/vendor/LICENSE')));
});

test('a diff over 1 MB comes out whole (execFileSync truncates at its default maxBuffer)', () => {
  const { execFileSync } = require('child_process');
  const a = mkdir('pg-big-a-');
  const b = mkdir('pg-big-b-');
  const line = (i) => `line ${i} ${'x'.repeat(60)}\n`;
  fs.writeFileSync(path.join(a, 'big.txt'), Array.from({ length: 30000 }, (_, i) => line(i)).join(''));
  fs.writeFileSync(path.join(b, 'big.txt'), Array.from({ length: 30000 }, (_, i) => line(-i)).join(''));
  const patch = generatePatch(a, b, 'plugins/big');
  assert.ok(patch.length > 2 * 1024 * 1024, `patch is ${patch.length} bytes`);
  const work = mkdir('pg-big-w-');
  fs.mkdirSync(path.join(work, 'plugins/big'), { recursive: true });
  fs.copyFileSync(path.join(a, 'big.txt'), path.join(work, 'plugins/big/big.txt'));
  fs.writeFileSync(path.join(work, 'p.patch'), patch);
  execFileSync('git', ['apply', '-p0', 'p.patch'], { cwd: work });
  assert.strictEqual(fs.readFileSync(path.join(work, 'plugins/big/big.txt'), 'utf8'), fs.readFileSync(path.join(b, 'big.txt'), 'utf8'));
});
