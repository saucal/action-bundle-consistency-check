'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseContentDiff, modifiedPaths } = require('../lib/parse-content-diff');

const SAMPLE = [
  'diff --git --simple D wp-content/cron-debug.log.tick',
  'diff --git --simple A plugins/newplug/new.php',
  'diff --git --simple WS plugins/crlf-plug/main.php',
  'diff --git a/plugins/tooltips-pro/tooltips.php b/plugins/tooltips-pro/tooltips.php',
  'index b2567a0..1166545 100644',
  '--- a/plugins/tooltips-pro/tooltips.php',
  '+++ b/plugins/tooltips-pro/tooltips.php',
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
  assert.deepStrictEqual([...set], ['plugins/crlf-plug/main.php', 'plugins/tooltips-pro/tooltips.php']);
});

test('empty / noise input yields no items', () => {
  assert.deepStrictEqual(parseContentDiff(''), []);
  assert.deepStrictEqual(parseContentDiff('some unrelated line\n@@ stray hunk\n'), []);
});
