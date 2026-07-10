'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { classify, versionConstraint } = require('../lib/classify');

// Resolvers stub: code-snippets is on wpackagist, churn-solution on satispress, others unknown.
const resolvers = {
  async wpackagist(kind, slug) {
    if (slug === 'code-snippets') return { source: 'wpackagist-plugin', package: 'wpackagist-plugin/code-snippets', version: '3.6.5' };
    if (slug === 'official-facebook-pixel') return { source: 'wpackagist-plugin', package: 'wpackagist-plugin/official-facebook-pixel', version: '3.0.0' };
    return null;
  },
  async satispress(slug) {
    if (slug === 'churn-solution') return { source: 'satispress', package: 'saucal/churn-solution', version: '2.1.0' };
    return null;
  },
};

function findKey(out, key) { return out.find((c) => c.key === key); }

test('versionConstraint', () => {
  assert.strictEqual(versionConstraint('3.6.5'), '>=3.6.5');
  assert.strictEqual(versionConstraint(null), '*');
});

test('wpackagist plugin -> recoverable composer add (version from tree header when present)', async () => {
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(treeRoot, 'plugins', 'code-snippets'), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'code-snippets', 'code-snippets.php'), '<?php /* Plugin Name: Code Snippets\nVersion: 3.6.5.1 */');
  const items = [{ path: 'plugins/code-snippets/code-snippets.php', side: 'remote-only' }];
  const out = await classify(items, { resolvers, treeRoot });
  const c = findKey(out, 'code-snippets');
  assert.strictEqual(c.recoverable, true);
  assert.strictEqual(c.category, 'wpackagist-plugin');
  assert.strictEqual(c.composerPackage, 'wpackagist-plugin/code-snippets');
  assert.strictEqual(c.version, '3.6.5.1'); // tree header wins over resolver version
});

test('satispress fallback for premium plugin', async () => {
  const out = await classify([{ path: 'plugins/churn-solution/churn.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  const c = findKey(out, 'churn-solution');
  assert.strictEqual(c.recoverable, true);
  assert.strictEqual(c.category, 'satispress');
  assert.strictEqual(c.composerPackage, 'saucal/churn-solution');
});

test('unknown premium plugin -> premium-flag (not recoverable)', async () => {
  const out = await classify([{ path: 'plugins/microsoft-clarity/clarity.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  const c = findKey(out, 'microsoft-clarity');
  assert.strictEqual(c.recoverable, false);
  assert.strictEqual(c.category, 'premium-flag');
});

test('sensitive mu-plugin and root junk classified, never recoverable', async () => {
  const out = await classify([
    { path: 'mu-plugins/00-sendlane-credentials.php', side: 'remote-only' },
    { path: 'purge-found-debug.json', side: 'remote-only' },
  ], { resolvers, treeRoot: '/nonexistent' });
  assert.strictEqual(findKey(out, 'mu-plugins/00-sendlane-credentials.php').category, 'sensitive');
  assert.strictEqual(findKey(out, 'purge-found-debug.json').category, 'ignorable');
});

test('wp-core path -> recoverable core bump', async () => {
  const out = await classify([{ path: 'wp-admin/about.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  const c = findKey(out, 'wp-admin/about.php');
  assert.strictEqual(c.category, 'wp-core');
  assert.strictEqual(c.recoverable, true);
});

test('build-only path -> needs-redeploy', async () => {
  const out2 = await classify([{ path: 'robots.txt', side: 'build-only' }], { resolvers, treeRoot: '/nonexistent' });
  assert.strictEqual(findKey(out2, 'robots.txt').category, 'needs-redeploy');
});

test('modified wpackagist plugin -> patched-candidate (recoverable, composer package set)', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  fs.mkdirSync(path.join(treeRoot, 'plugins', 'code-snippets'), { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'plugins', 'code-snippets', 'code-snippets.php'), '<?php /* Plugin Name: Code Snippets\nVersion: 3.6.5.1 */');
  const items = [{ path: 'plugins/code-snippets/code-snippets.php', side: 'remote-only' }];
  const modifiedPaths = new Set(['plugins/code-snippets/code-snippets.php']);
  const out = await classify(items, { resolvers, treeRoot, modifiedPaths });
  const c = findKey(out, 'code-snippets');
  assert.strictEqual(c.category, 'patched-candidate');
  assert.strictEqual(c.recoverable, true);
  assert.strictEqual(c.composerPackage, 'wpackagist-plugin/code-snippets');
  assert.strictEqual(c.version, '3.6.5.1');
});

test('resolvable plugin with NO modified paths still -> plain add (not patched)', async () => {
  const out = await classify([{ path: 'plugins/code-snippets/code-snippets.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  assert.strictEqual(findKey(out, 'code-snippets').category, 'wpackagist-plugin');
});

test('modifiedPaths defaults to empty when omitted (backward compatible)', async () => {
  const out = await classify([{ path: 'plugins/churn-solution/churn.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  assert.strictEqual(findKey(out, 'churn-solution').category, 'satispress'); // unchanged
});

test('resolvable component verdict carries root and kind', async () => {
  const out = await classify([{ path: 'plugins/code-snippets/code-snippets.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  const c = out.find((x) => x.key === 'code-snippets');
  assert.strictEqual(c.root, 'plugins/code-snippets');
  assert.strictEqual(c.kind, 'plugin');
});

test('resolvable plugin with a sensitive-looking bundled file still classifies as an add', async () => {
  const items = [
    { path: 'plugins/code-snippets/code-snippets.php', side: 'remote-only' },
    { path: 'plugins/code-snippets/includes/wp-config-helper.php', side: 'remote-only' }, // matches sensitive regex
  ];
  const out = await classify(items, { resolvers, treeRoot: '/nonexistent' });
  const c = findKey(out, 'code-snippets');
  assert.strictEqual(c.category, 'wpackagist-plugin');
  assert.strictEqual(c.recoverable, true);
});

test('non-resolvable plugin with a sensitive file is still flagged sensitive', async () => {
  const out = await classify([{ path: 'plugins/unknownplug/secret-credentials.php', side: 'remote-only' }], { resolvers, treeRoot: '/nonexistent' });
  const c = findKey(out, 'unknownplug');
  assert.strictEqual(c.category, 'sensitive');
  assert.strictEqual(c.recoverable, false);
});
