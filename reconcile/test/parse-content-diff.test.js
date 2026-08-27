'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseContentDiff, modifiedPaths } = require('../lib/parse-content-diff');

const SAMPLE = [
  'diff --git --simple D wp-content/cron-debug.log.tick',
  'diff --git --simple A plugins/newplug/new.php',
  'diff --git --simple WS plugins/crlf-plug/main.php',
  'diff --git b/plugins/tooltips-pro/tooltips.php a/plugins/tooltips-pro/tooltips.php',
  'index b2567a0..1166545 100644',
  '--- b/plugins/tooltips-pro/tooltips.php',
  '+++ a/plugins/tooltips-pro/tooltips.php',
  '@@ -701,7 +701,7 @@',
  '-    $wp_rewrite->flush_rules();',
  '+    // disabled',
].join('\n');

test('classifies simple A/D entries and standard modified headers', () => {
  const items = parseContentDiff(SAMPLE);
  assert.deepStrictEqual(items, [
    { path: 'wp-content/cron-debug.log.tick', status: 'D' },
    { path: 'plugins/newplug/new.php', status: 'A' },
    { path: 'plugins/crlf-plug/main.php', status: 'WS' },
    { path: 'plugins/tooltips-pro/tooltips.php', status: 'M' },
  ]);
});

test('modified header without a/ b/ prefixes is still parsed as M', () => {
  const items = parseContentDiff('diff --git plugins/x/main.php plugins/x/main.php\n@@ -1 +1 @@\n-a\n+b\n');
  assert.deepStrictEqual(items, [{ path: 'plugins/x/main.php', status: 'M' }]);
});

test('modifiedPaths returns the M- and WS-status paths as a Set', () => {
  const set = modifiedPaths(parseContentDiff(SAMPLE));
  assert.ok(set instanceof Set);
  assert.deepStrictEqual([...set], [
    'plugins/crlf-plug/main.php',
    'plugins/tooltips-pro/tooltips.php',
  ]);
});

test('absent and renamed statuses are not content modifications', () => {
  const set = modifiedPaths(parseContentDiff(
    'diff --git --simple A a.php\ndiff --git --simple D b.php\ndiff --git --simple R c.php\n'
  ));
  assert.deepStrictEqual([...set], []);
});

test('empty / noise input yields no items', () => {
  assert.deepStrictEqual(parseContentDiff(''), []);
  assert.deepStrictEqual(parseContentDiff('some unrelated line\n@@ stray hunk\n'), []);
});

test('reverse-diff headers strip the b/ prefix, not just a/', () => {
  // consistency-diff.sh runs `git diff -R`, so the b/ side comes first. Leaving the
  // prefix on made every content-modified path unmatchable against a component path.
  const items = parseContentDiff('diff --git b/wp-content/plugins/foo/bar.php a/wp-content/plugins/foo/bar.php\n');
  assert.deepStrictEqual(items, [{ path: 'wp-content/plugins/foo/bar.php', status: 'M' }]);
});

test('an LL-tagged header is a modified file whose body was truncated', () => {
  const items = parseContentDiff([
    'diff --git --simple LL b/plugins/ui/dist/app.min.js a/plugins/ui/dist/app.min.js',
    '@@ -2 +2 @@',
    '-var a=2;xxx... [target line, 39.1 KB, truncated]',
    '+var a=1;xxx... [build line, 39.1 KB, truncated]',
  ].join('\n'));
  assert.deepStrictEqual(items, [{ path: 'plugins/ui/dist/app.min.js', status: 'M' }]);
  assert.deepStrictEqual([...modifiedPaths(items)], ['plugins/ui/dist/app.min.js']);
});

test('a tagged header is not confused with a bodiless one-liner', () => {
  const items = parseContentDiff('diff --git --simple WS plugins/x/main.php\n');
  assert.deepStrictEqual(items, [{ path: 'plugins/x/main.php', status: 'WS' }]);
});
