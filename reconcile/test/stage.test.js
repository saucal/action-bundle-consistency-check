'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { stageOutputs, keepRefused } = require('../lib/stage');
const { remaining, reportBody } = require('../lib/report');

test('stageOutputs: an item git refuses to stage is counted and named, never reported as already carried', async () => {
  const c = { key: 'customx', category: 'tracked', recoverable: true, verified: true, paths: ['plugins/customx/assets/blob.bin'] };
  const result = { classified: [c], trackedPaths: ['plugins/customx/assets/blob.bin'], adoptedPaths: [] };
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'add') return { code: 1, out: 'The following paths are ignored by one of your .gitignore files:\nplugins/customx\nhint: Use -f if you really want to add them.\n' };
    return { code: 0, out: '' };
  };
  const staged = await stageOutputs(os.tmpdir(), result, () => false, git);

  assert.deepStrictEqual(staged, []);
  assert.ok(calls.includes('reset -q -- plugins/customx/assets/blob.bin'), calls.join('\n'));
  assert.strictEqual(c.recoverable, false);
  assert.match(c.remediation, /^customx: .*could not be staged.*\.gitignore ignores `plugins\/customx`\. \*\*To match:\*\* .*SSH_IGNORE_LIST_EXTRA/);
  assert.doesNotMatch(c.remediation, /files:|hint:/);
  assert.strictEqual(remaining(result.classified), '1 item(s) need a decision');
  const body = reportBody(result.classified, { ref: 'main', runUrl: 'u', already: true });
  assert.doesNotMatch(body, /next Deploy ships them/);
  assert.match(body, /`customx` — .*could not be staged/);
});

test('stageOutputs: adopted roots are force-added, tracked files are not', async () => {
  const result = {
    classified: [
      { key: 'newx', category: 'adopted', recoverable: true, adoptedRoot: 'plugins/newx' },
      { key: 'customx', category: 'tracked', recoverable: true, paths: ['plugins/customx/a.php', 'plugins/customx/link'] },
    ],
    trackedPaths: ['plugins/customx/a.php'], // the symlink is never copied
    adoptedPaths: ['plugins/newx'],
  };
  const calls = [];
  await stageOutputs(os.tmpdir(), result, () => false, async (args) => { calls.push(args.join(' ')); return { code: 0, out: '' }; });
  assert.ok(calls.includes('add -f -- plugins/newx'), calls.join('\n'));
  assert.ok(calls.includes('add -A -- plugins/customx/a.php'), calls.join('\n'));
  assert.ok(result.classified.every((c) => c.recoverable));
});

test('stageOutputs: an item git refuses drops its hold reasons but keeps its security notes, labelled not in this PR', async () => {
  const c = { key: 'customx', category: 'tracked', recoverable: true, paths: ['plugins/customx/blob.bin'] };
  const other = { key: 'othery', category: 'tracked', recoverable: true, paths: ['plugins/othery/a.php'] };
  const result = {
    classified: [c, other], trackedPaths: ['plugins/customx/blob.bin', 'plugins/othery/a.php'], adoptedPaths: [],
    autoMerge: { ok: false, reasons: ['customx: binary, new-file', 'othery: script-file'] },
    security: { critical: [], warn: [{ key: 'customx', file: 'plugins/customx/blob.bin', rule: 'binary', line: 0 }, { key: 'othery', file: 'plugins/othery/a.php', rule: 'script-file', line: 0 }] },
  };
  const git = async (args) => (args[0] === 'add' && args.includes('plugins/customx/blob.bin')
    ? { code: 1, out: 'The following paths are ignored by one of your .gitignore files:\nplugins/customx\n' } : { code: 0, out: '' });
  await stageOutputs(os.tmpdir(), result, () => false, git);

  assert.deepStrictEqual(result.autoMerge.reasons, ['othery: script-file']);
  assert.deepStrictEqual(result.security.warn.map((h) => [h.key, h.rule, !!h.notInPr]), [['customx', 'binary', true], ['othery', 'script-file', false]]);
  assert.strictEqual(result.autoMerge.ok, false); // the verdict stays as decided
  const body = reportBody(result.classified, { ref: 'main', runUrl: 'u' });
  assert.match(body, /1 need a decision/);
  assert.match(body, /`customx` — .*could not be staged/);
});

test('keepRefused: a mixed heal names an item git refused as needing a decision, never "the next run opens a PR"', async () => {
  const run1 = { key: 'customx', category: 'tracked', recoverable: true, paths: ['plugins/customx/blob.bin'] };
  await stageOutputs(os.tmpdir(), { classified: [run1], trackedPaths: run1.paths, adoptedPaths: [] }, () => false,
    async (args) => (args[0] === 'add' ? { code: 1, out: 'The following paths are ignored by one of your .gitignore files:\nplugins/customx\n' } : { code: 0, out: '' }));
  const rerun = [
    { key: 'customx', category: 'deferred', recoverable: false, remediation: 'customx: left for review — the next run opens a PR for it.' },
    { key: 'helddz', category: 'deferred', recoverable: false, remediation: 'helddz: left for review — the next run opens a PR for it.' },
    { key: 'okx', category: 'tracked', recoverable: true, verified: true, paths: ['plugins/okx/a.php'] },
  ];
  const classified = keepRefused(rerun, [run1]);
  assert.strictEqual(classified[0], run1);
  assert.strictEqual(classified[1], rerun[1]);
  const body = reportBody(classified, { ref: 'main', runUrl: 'u' });
  assert.doesNotMatch(body, /`customx` — [^\n]*next run/);
  assert.match(body, /`customx` — .*could not be staged/);
  assert.match(body, /`helddz` — [^\n]*next run opens a PR/);
  assert.strictEqual(remaining(classified), "1 item(s) need a decision, 1 item(s) wait for the next run's PR or the next Deploy");
});
