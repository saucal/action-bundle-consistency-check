'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { stageOutputs } = require('../lib/stage');
const { remaining, reportBody } = require('../lib/report');

test('stageOutputs: an item git refuses to stage is counted and named, never reported as already carried', async () => {
  const c = { key: 'customx', category: 'tracked', recoverable: true, verified: true, paths: ['plugins/customx/assets/blob.bin'] };
  const result = { classified: [c], trackedPaths: ['plugins/customx/assets/blob.bin'], adoptedPaths: [] };
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'add') return { code: 1, out: 'The following paths are ignored by one of your .gitignore files:\nplugins/customx\n' };
    return { code: 0, out: '' };
  };
  const staged = await stageOutputs(os.tmpdir(), result, () => false, git);

  assert.deepStrictEqual(staged, []);
  assert.ok(calls.includes('reset -q -- plugins/customx/assets/blob.bin'), calls.join('\n'));
  assert.strictEqual(c.recoverable, false);
  assert.match(c.remediation, /^customx: .*could not be staged.*ignored/);
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
