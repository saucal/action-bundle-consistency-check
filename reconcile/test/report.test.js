'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reportBody } = require('../lib/report');

const classified = [
  { key: 'code-snippets', category: 'wpackagist-plugin', recoverable: true, composerPackage: 'wpackagist-plugin/code-snippets', remediation: 'Added wpackagist-plugin/code-snippets:>=3.6.5' },
  { key: 'microsoft-clarity', category: 'premium-flag', recoverable: false, remediation: 'Premium plugin not on wpackagist or SatisPress.' },
  { key: 'mu-plugins/00-credentials.php', category: 'sensitive', recoverable: false, remediation: 'Sensitive file; review manually.' },
  { key: 'purge-found-debug.json', category: 'ignorable', recoverable: false, remediation: 'Runtime junk; add to SSH_IGNORE_LIST.' },
];

test('splits what the PR changes from the drift it leaves alone', () => {
  const body = reportBody(classified, { ref: 'main', runUrl: 'https://example/run/1' });
  const inIdx = body.indexOf('### In this PR');
  const outIdx = body.indexOf('### Not in this PR');
  assert.ok(inIdx !== -1 && outIdx > inIdx, body);
  assert.match(body.slice(inIdx, outIdx), /wpackagist-plugin\/code-snippets/);
  assert.doesNotMatch(body.slice(inIdx, outIdx), /microsoft-clarity|credentials/);
  assert.match(body.slice(outIdx), /`microsoft-clarity` — Premium plugin/);
  assert.match(body.slice(outIdx), /⛔ `mu-plugins\/00-credentials\.php`/);
  assert.match(body, /<summary>1 runtime\/junk file\(s\) ignored<\/summary>/);
  assert.match(body, /2 drifted item\(s\) are not covered/);
  assert.match(body, /https:\/\/example\/run\/1/);
});

test('omits empty sections', () => {
  const body = reportBody([{ key: 'x', category: 'ignorable', recoverable: false, remediation: 'junk' }], { ref: 'develop', runUrl: 'u' });
  assert.doesNotMatch(body, /### In this PR|### Not in this PR/);
});

test('left-out kinds say what to do instead of classifier jargon', () => {
  const body = reportBody([
    { key: 'w3tc-config/master.php', category: 'unknown', recoverable: false, remediation: 'Unclassified drift (w3tc-config/master.php). Review manually.' },
    { key: 'mu/.gitignore', category: 'needs-redeploy', recoverable: false, remediation: 'In build but missing/changed on server.' },
  ], { ref: 'main', runUrl: 'u' });
  assert.match(body, /`w3tc-config\/master\.php` — only on the server, and not a plugin, theme or tracked file/);
  assert.match(body, /`mu\/\.gitignore` — in the build, but missing or different on the server\. Not a repo change/);
  assert.doesNotMatch(body, /Unclassified drift/);
});

test('patches and adoptions are marked inside the PR list; verify tags render', () => {
  const body = reportBody([
    { key: 'ok', category: 'wpackagist-plugin', recoverable: true, composerPackage: 'wpackagist-plugin/ok', remediation: 'locked', verified: true },
    { key: 'p', category: 'patched-candidate', recoverable: true, composerPackage: 'saucal/p', remediation: 'patched', verified: true },
    { key: 'part', category: 'adopted', recoverable: true, remediation: 'vendored', verified: false, residualFiles: 3 },
  ], { ref: 'main', runUrl: 'u' });
  assert.match(body, /- `wpackagist-plugin\/ok` — locked ✅/);
  assert.match(body, /- 🩹 `saucal\/p` — patched ✅/);
  assert.match(body, /- 📦 `part` — vendored ⚠️ 3 file\(s\) still differ/);
  assert.match(body, /brings 3 item\(s\) in line with the server; 1 still differ/);
});

test('all verified -> the summary says each was checked', () => {
  const body = reportBody([{ key: 'ok', category: 'wpackagist-plugin', recoverable: true, composerPackage: 'wpackagist-plugin/ok', remediation: 'add', verified: true }], { ref: 'main', runUrl: 'u' });
  assert.match(body, /brings 1 item\(s\) in line with the server, each checked to reproduce it/);
});
