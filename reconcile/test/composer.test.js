'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { upsertRequire, ensureCweagansSetup, serializeComposer } = require('../lib/composer');

test('adds a new package and reports changed', () => {
  const base = { require: { 'php': '>=8.1' } };
  const { composer, changed } = upsertRequire(base, 'wpackagist-plugin/code-snippets', '>=3.6.5');
  assert.strictEqual(changed, true);
  assert.strictEqual(composer.require['wpackagist-plugin/code-snippets'], '>=3.6.5');
  assert.strictEqual(base.require['wpackagist-plugin/code-snippets'], undefined); // input untouched
});

test('creates require block when absent', () => {
  const { composer } = upsertRequire({}, 'saucal/churn-solution', '>=2.1.0');
  assert.strictEqual(composer.require['saucal/churn-solution'], '>=2.1.0');
});

test('no-op when constraint already matches', () => {
  const base = { require: { 'wpackagist-plugin/x': '>=1.0.0' } };
  const { changed } = upsertRequire(base, 'wpackagist-plugin/x', '>=1.0.0');
  assert.strictEqual(changed, false);
});

test('ensureCweagansSetup adds require, allow-plugins, and the post-install hook', () => {
  const { composer, changed } = ensureCweagansSetup({ name: 'x/y', require: { php: '>=8.1' } });
  assert.strictEqual(changed, true);
  assert.strictEqual(composer.require['cweagans/composer-patches'], '>=2.0.0');
  assert.strictEqual(composer.config['allow-plugins']['cweagans/composer-patches'], true);
  assert.ok(composer.scripts['post-install-cmd'].some((l) => l.includes('.patches_applied')));
});

test('ensureCweagansSetup preserves an existing post-install-cmd and is idempotent', () => {
  const first = ensureCweagansSetup({ scripts: { 'post-install-cmd': ['echo hi'] } }).composer;
  assert.ok(first.scripts['post-install-cmd'].includes('echo hi'));
  const again = ensureCweagansSetup(first);
  assert.strictEqual(again.changed, false);
  assert.strictEqual(again.composer.scripts['post-install-cmd'].length, first.scripts['post-install-cmd'].length);
});

test('serializeComposer keeps the original repositories order (no integer-key hoisting)', () => {
  const original = [
    '{',
    '    "name": "t/t",',
    '    "repositories": {',
    '        "satispress": { "type": "composer", "url": "https://packages.saucal.com/satispress/" },',
    '        "0": { "type": "composer", "url": "https://wpackagist.org" }',
    '    },',
    '    "require": { "php": ">=8.1" }',
    '}',
    '',
  ].join('\n');
  const obj = JSON.parse(original); // JSON.parse hoists "0" ahead of "satispress"
  obj.require['wpackagist-plugin/x'] = '>=1.0.0';
  const out = serializeComposer(obj, original);
  assert.ok(out.indexOf('"satispress"') < out.indexOf('"0"'), `repositories reordered:\n${out}`);
  assert.match(out, /"wpackagist-plugin\/x": ">=1\.0\.0"/);
  assert.deepStrictEqual(JSON.parse(out).repositories, obj.repositories);
});

test('serializeComposer without original text is plain stringify', () => {
  assert.strictEqual(serializeComposer({ a: 1 }), JSON.stringify({ a: 1 }, null, 4) + '\n');
});
