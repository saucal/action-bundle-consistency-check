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
  const inIdx = body.indexOf('### Repo changes in this PR');
  const outIdx = body.indexOf("### Repo changes this PR can't make");
  assert.ok(inIdx !== -1 && outIdx > inIdx, body);
  assert.match(body.slice(inIdx, outIdx), /wpackagist-plugin\/code-snippets/);
  assert.doesNotMatch(body.slice(inIdx, outIdx), /microsoft-clarity|credentials/);
  assert.match(body.slice(outIdx), /`microsoft-clarity` — Premium plugin/);
  assert.match(body.slice(outIdx), /⛔ `mu-plugins\/00-credentials\.php`/);
  assert.match(body, /<summary>1 runtime\/junk file\(s\) ignored<\/summary>/);
  assert.match(body, /3 repo change\(s\) would make them match\. This PR makes 1; 2 need a decision/);
  assert.match(body, /https:\/\/example\/run\/1/);
});

test('omits empty sections', () => {
  const body = reportBody([{ key: 'x', category: 'ignorable', recoverable: false, remediation: 'junk' }], { ref: 'develop', runUrl: 'u' });
  assert.doesNotMatch(body, /### Repo changes/);
});

test('left-out kinds say what to do instead of classifier jargon', () => {
  const body = reportBody([
    { key: 'w3tc-config/master.php', category: 'unknown', recoverable: false, remediation: 'Unclassified drift (w3tc-config/master.php). Review manually.' },
    { key: 'mu/.gitignore', category: 'needs-redeploy', recoverable: false, onServer: false, remediation: 'In build but missing/changed on server.' },
    { key: 'mu/x.php', category: 'needs-redeploy', recoverable: false, onServer: true, remediation: 'In build but missing/changed on server.' },
  ], { ref: 'main', runUrl: 'u' });
  assert.match(body, /`w3tc-config\/master\.php` — on the server, not in the repo\. \*\*To match:\*\* commit it, or add it to `SSH_IGNORE_LIST_EXTRA`/);
  assert.match(body, /`mu\/\.gitignore` — in the build, not on the server\. \*\*To match:\*\* add it to `SSH_IGNORE_LIST_EXTRA`/);
  assert.match(body, /`mu\/x\.php` — changed on the server, but the build adds it/);
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
  assert.match(body, /This PR makes all of them; 1 still differ after the change/);
});

test('all verified -> the summary says each was checked', () => {
  const body = reportBody([{ key: 'ok', category: 'wpackagist-plugin', recoverable: true, composerPackage: 'wpackagist-plugin/ok', remediation: 'add', verified: true }], { ref: 'main', runUrl: 'u' });
  assert.match(body, /1 repo change\(s\) would make them match\. This PR makes all of them \(each checked against the server's files ✅\)/);
});

test('already in the branch: no PR wording, says what this run does', () => {
  const items = [
    { key: 'ok', category: 'wpackagist-plugin', recoverable: true, composerPackage: 'wpackagist-plugin/ok', remediation: 'add', verified: true },
    { key: 'w3tc-config/master.php', category: 'unknown', recoverable: false, remediation: 'x' },
  ];
  const body = reportBody(items, { ref: 'main', runUrl: 'u', already: '0a214e4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.match(body, /`main` already has the 1 repo change\(s\) that match the server, so there's no PR\. They came in with `0a214e4`.*records it there, without deploying\. 1 need a decision/);
  assert.match(body, /### Already in `main`/);
  assert.match(body, /### Repo changes still to make/);
  assert.doesNotMatch(body, /this PR/i);
  assert.match(reportBody(items, { ref: 'main', runUrl: 'u', already: true }), /in commits not deployed yet: the next Deploy ships them/);
  const onlyOpen = reportBody([items[1]], { ref: 'main', runUrl: 'u', already: true });
  assert.match(onlyOpen, /No repo change would bring `main` closer to the server, so there's no PR\. 1 need a decision/);
  assert.doesNotMatch(onlyOpen, /already has|### Already/);
});

test('a deferred item says why run 1 held it', () => {
  const body = reportBody([...classified, { key: 'query-monitor', category: 'deferred', recoverable: false, held: 'known vulnerability at v3.15.0 — CVE-2026-1' }], { ref: 'main', runUrl: 'u' });
  assert.match(body, /`query-monitor` — left out of this PR for review \(known vulnerability at v3\.15\.0 — CVE-2026-1\); the next run opens a PR for it\./);
});
