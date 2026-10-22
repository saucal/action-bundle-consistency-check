'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseHeader, pluginVersion, themeVersion } = require('../lib/extract-version');

test('parseHeader reads Version and Plugin Name from a WP header block', () => {
  const content = `<?php\n/**\n * Plugin Name: Code Snippets\n * Version: 3.6.5.1\n */\n`;
  assert.deepStrictEqual(parseHeader(content), { version: '3.6.5.1', name: 'Code Snippets' });
});

test('pluginVersion scans a directory for the main file header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-'));
  fs.writeFileSync(path.join(dir, 'code-snippets.php'), '<?php\n/* Plugin Name: Code Snippets\nVersion: 3.6.5.1 */');
  assert.deepStrictEqual(pluginVersion(dir), { version: '3.6.5.1', name: 'Code Snippets' });
  assert.strictEqual(pluginVersion(path.join(dir, 'missing')), null);
});

test('pluginVersion skips a file whose Version line is not the plugin header (w3-total-cache)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-'));
  fs.writeFileSync(path.join(dir, 'Extension_CloudFlare_Plugin.php'), '<?php\n/**\n * Version: 1.2\n */');
  fs.writeFileSync(path.join(dir, 'w3-total-cache.php'), '<?php\n/*\nPlugin Name: W3 Total Cache\nVersion: 2.8.1\n*/');
  assert.deepStrictEqual(pluginVersion(dir), { version: '2.8.1', name: 'W3 Total Cache' });
});

test('themeVersion reads style.css', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-'));
  fs.writeFileSync(path.join(dir, 'style.css'), '/*\nTheme Name: Storefront\nVersion: 4.5.2\n*/');
  assert.deepStrictEqual(themeVersion(dir), { version: '4.5.2', name: 'Storefront' });
});
