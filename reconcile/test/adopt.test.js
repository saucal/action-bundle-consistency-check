'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { adoptComponent } = require('../lib/adopt');

function mktmp(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

test('adoptComponent copies the whole server component dir into source', () => {
  const server = mktmp('srv-');
  const src = mktmp('src-');
  fs.mkdirSync(path.join(server, 'plugins/foo/inc'), { recursive: true });
  fs.writeFileSync(path.join(server, 'plugins/foo/foo.php'), '<?php // foo');
  fs.writeFileSync(path.join(server, 'plugins/foo/inc/lib.php'), '<?php // lib');
  const res = adoptComponent({ sourceDir: src, treeRoot: server, root: 'plugins/foo' });
  assert.strictEqual(res.files, 2);
  assert.strictEqual(res.skipped, 0);
  assert.ok(fs.existsSync(path.join(src, 'plugins/foo/foo.php')));
  assert.ok(fs.existsSync(path.join(src, 'plugins/foo/inc/lib.php')));
});

test('adoptComponent skips sensitive files (never vendor credentials)', () => {
  const server = mktmp('srv-'); const src = mktmp('src-');
  fs.mkdirSync(path.join(server, 'plugins/foo'), { recursive: true });
  fs.writeFileSync(path.join(server, 'plugins/foo/foo.php'), '<?php');
  fs.writeFileSync(path.join(server, 'plugins/foo/secret-credentials.php'), '<?php return ["k"=>"v"];');
  const isSensitive = (rel) => /credentials/.test(rel);
  const res = adoptComponent({ sourceDir: src, treeRoot: server, root: 'plugins/foo', isSensitive });
  assert.strictEqual(res.files, 1);
  assert.strictEqual(res.skipped, 1);
  assert.ok(fs.existsSync(path.join(src, 'plugins/foo/foo.php')));
  assert.ok(!fs.existsSync(path.join(src, 'plugins/foo/secret-credentials.php')), 'sensitive file not vendored');
});

test('adoptComponent throws when the server dir is missing', () => {
  const src = mktmp('src-');
  assert.throws(() => adoptComponent({ sourceDir: src, treeRoot: '/nonexistent', root: 'plugins/x' }));
});

test('adoptComponent replaces an existing dir cleanly (removes stale files)', () => {
  const server = mktmp('srv-'); const src = mktmp('src-');
  fs.mkdirSync(path.join(server, 'plugins/foo'), { recursive: true });
  fs.writeFileSync(path.join(server, 'plugins/foo/new.php'), 'new');
  fs.mkdirSync(path.join(src, 'plugins/foo'), { recursive: true });
  fs.writeFileSync(path.join(src, 'plugins/foo/old.php'), 'old');
  adoptComponent({ sourceDir: src, treeRoot: server, root: 'plugins/foo' });
  assert.ok(fs.existsSync(path.join(src, 'plugins/foo/new.php')));
  assert.ok(!fs.existsSync(path.join(src, 'plugins/foo/old.php')), 'stale file removed');
});
