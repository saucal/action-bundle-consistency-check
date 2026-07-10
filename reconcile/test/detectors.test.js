'use strict';
const test = require('node:test');
const assert = require('node:assert');
const d = require('../lib/detectors');

test('isCompiledAsset', () => {
  assert.ok(d.isCompiledAsset('plugins/x/assets/app.min.js'));
  assert.ok(d.isCompiledAsset('plugins/x/build/index.js'));
  assert.ok(d.isCompiledAsset('plugins/x/app.js.map'));
  assert.ok(!d.isCompiledAsset('plugins/x/main.php'));
});

test('isSensitive', () => {
  assert.ok(d.isSensitive('mu-plugins/00-sendlane-credentials.php'));
  assert.ok(d.isSensitive('.env'));
  assert.ok(d.isSensitive('wp-config.php'));
  assert.ok(!d.isSensitive('plugins/x/readme.txt'));
});

test('isIgnorable', () => {
  assert.ok(d.isIgnorable('wp-content/cron-debug.log.tick'));
  assert.ok(d.isIgnorable('purge-found-debug.json'));
  assert.ok(d.isIgnorable('error.log'));
  assert.ok(!d.isIgnorable('plugins/x/main.php'));
});

test('isVendorPath', () => {
  assert.ok(d.isVendorPath('plugins/x/vendor/foo/bar.php'));
  assert.ok(!d.isVendorPath('plugins/x/src/bar.php'));
});

test('componentOf maps plugin/theme/mu paths (with or without wp-content prefix)', () => {
  assert.deepStrictEqual(d.componentOf('plugins/code-snippets/code-snippets.php'),
    { kind: 'plugin', slug: 'code-snippets', root: 'plugins/code-snippets' });
  assert.deepStrictEqual(d.componentOf('wp-content/themes/storefront/style.css'),
    { kind: 'theme', slug: 'storefront', root: 'wp-content/themes/storefront' });
  assert.deepStrictEqual(d.componentOf('mu-plugins/00-x.php'),
    { kind: 'mu-plugin', slug: '00-x.php', root: 'mu-plugins/00-x.php' });
  assert.strictEqual(d.componentOf('purge-found-debug.json'), null);
});
