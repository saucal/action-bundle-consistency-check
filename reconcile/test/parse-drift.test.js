'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseManifest } = require('../lib/parse-drift');

const fx = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

test('flags remote-only ("deleting") vs build-only paths', () => {
  const items = parseManifest('deleting plugins/code-snippets/code-snippets.php\nplugins/microsoft-clarity/readme.txt\n');
  assert.deepStrictEqual(items, [
    { path: 'plugins/code-snippets/code-snippets.php', side: 'remote-only' },
    { path: 'plugins/microsoft-clarity/readme.txt', side: 'build-only' },
  ]);
});

test('drops directories, header comments, and rsync noise', () => {
  const items = parseManifest(fx('talkbox-syncplan.txt'));
  assert.deepStrictEqual(items, [{ path: 'wp-content/cron-debug.log.tick', side: 'remote-only' }]);
});

test('phlearn: ignores "cannot delete" noise and trailing-slash dirs', () => {
  const items = parseManifest(fx('phlearn-manifest.txt'));
  assert.deepStrictEqual(items, [
    { path: 'plugins/official-facebook-pixel/facebook-commerce.php', side: 'remote-only' },
  ]);
});
