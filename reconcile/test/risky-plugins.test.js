'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { riskyPluginCategory } = require('../lib/risky-plugins');

test('riskyPluginCategory: free and pro (SatisPress) slugs match; others and themes do not', () => {
  assert.strictEqual(riskyPluginCategory('wpackagist-plugin/wp-file-manager'), 'file manager');
  assert.strictEqual(riskyPluginCategory('saucal/custom-css-js-pro'), 'code snippets / code execution');
  assert.strictEqual(riskyPluginCategory('saucal/wp-migrate-db-pro'), 'site export / migration');
  assert.strictEqual(riskyPluginCategory('wpackagist-plugin/hello-dolly'), null);
  assert.strictEqual(riskyPluginCategory('wpackagist-theme/code-snippets'), null);
});
