'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reportBody } = require('../lib/report');

const classified = [
  { key: 'code-snippets', category: 'wpackagist-plugin', recoverable: true, composerPackage: 'wpackagist-plugin/code-snippets', remediation: 'Add wpackagist-plugin/code-snippets:>=3.6.5' },
  { key: 'microsoft-clarity', category: 'premium-flag', recoverable: false, remediation: 'Premium plugin not on wpackagist or SatisPress.' },
  { key: 'mu-plugins/00-sendlane-credentials.php', category: 'sensitive', recoverable: false, remediation: 'Sensitive file; review manually.' },
  { key: 'purge-found-debug.json', category: 'ignorable', recoverable: false, remediation: 'Runtime junk; add to SSH_IGNORE_LIST.' },
];

test('renders outcome and all four sections', () => {
  const body = reportBody(classified, { ref: 'main', runUrl: 'https://example/run/1' });
  assert.match(body, /Outcome:\*\* partial/);
  assert.match(body, /### ✅ Applied/);
  assert.match(body, /wpackagist-plugin\/code-snippets/);
  assert.match(body, /### ⚠️ Needs review/);
  assert.match(body, /microsoft-clarity/);
  assert.match(body, /### 🧹 Ignorable/);
  assert.match(body, /### ⛔ Unrecoverable/);
  assert.match(body, /sendlane-credentials/);
  assert.match(body, /https:\/\/example\/run\/1/);
});

test('omits empty sections', () => {
  const body = reportBody([{ key: 'x', category: 'ignorable', recoverable: false, remediation: 'junk' }], { ref: 'develop', runUrl: 'u' });
  assert.match(body, /Outcome:\*\* ignorable-only/);
  assert.doesNotMatch(body, /### ✅ Applied/);
});
