'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { upsertRequire, ensureCweagansSetup, serializeComposer, isPinnedConstraint } = require('../lib/composer');

test('isPinnedConstraint: exact versions are pins, ranges are not', () => {
  for (const s of ['1.2.3', '1.2', '==1.2.3', 'v1.2.3', '1.2.3-beta2', 'dev-main']) {
    assert.strictEqual(isPinnedConstraint(s), true, `pin: ${s}`);
  }
  for (const s of ['>=1.2', '^1.2', '~1.2.3', '1.2.*', '>1.0 <2.0', '1.0 || 2.0', '*', '@dev', '', null]) {
    assert.strictEqual(isPinnedConstraint(s), false, `range: ${s}`);
  }
});

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

test('ensureCweagansSetup requires saucal/composer-patches and allows both plugins', () => {
  const { composer, changed } = ensureCweagansSetup({ name: 'x/y', require: { php: '>=8.1' } });
  assert.strictEqual(changed, true);
  assert.strictEqual(composer.require['saucal/composer-patches'], '>=1.1.0');
  assert.strictEqual(composer.require['cweagans/composer-patches'], undefined, 'cweagans comes in as its dependency');
  assert.strictEqual(composer.config['allow-plugins']['cweagans/composer-patches'], true);
  assert.strictEqual(composer.config['allow-plugins']['saucal/composer-patches'], true);
  assert.strictEqual(composer.scripts, undefined, 'no script hook');
});

test('ensureCweagansSetup drops the old jq hook, keeps other scripts, and is idempotent', () => {
  const OLD = 'PKGS=$(jq -r \'(.extra.patches // {}) | keys | join(" ")\' composer.json); if [ -n "$PKGS" ]; then HASH=$(jq -r \'._hash\' patches.lock.json 2>/dev/null); if [ -z "$HASH" ] || [ "$(cat .patches_applied 2>/dev/null)" != "$HASH" ]; then echo "Patches hash changed!" && echo "$HASH" > .patches_applied && composer reinstall $PKGS || rm -f .patches_applied; fi; fi';
  const first = ensureCweagansSetup({ require: { 'cweagans/composer-patches': '^2.0' }, scripts: { 'post-install-cmd': ['echo hi', OLD] } }).composer;
  assert.deepStrictEqual(first.scripts['post-install-cmd'], ['echo hi']);
  assert.strictEqual(first.require['cweagans/composer-patches'], '^2.0', 'an existing direct require is left alone');
  assert.strictEqual(ensureCweagansSetup(first).changed, false);
  const only = ensureCweagansSetup({ scripts: { 'post-install-cmd': OLD } }).composer;
  assert.strictEqual(only.scripts, undefined, 'empty scripts block removed');
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

