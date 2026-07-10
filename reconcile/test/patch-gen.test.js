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
