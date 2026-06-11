'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { upsertRequire } = require('../lib/composer');

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
