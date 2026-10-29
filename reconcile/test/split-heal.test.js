'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { splitHeal } = require('../lib/split-heal');

const full = {
  name: 'full',
  autoMerge: { ok: false, eligible: ['plugins/clean'] },
  classified: [{ key: 'plugins/clean' }, { key: 'plugins/held' }, { key: 'plugins/newer', category: 'superseded' }],
};

function fakes(stagedForPart) {
  const calls = [];
  return {
    calls,
    runOnce: async (only) => { calls.push(only ? `run ${[...only].join(',')}` : 'run all'); return { name: only ? 'part' : 'full again' }; },
    undo: async (r) => { calls.push(`undo ${r.name}`); },
    stage: async (r) => { calls.push(`stage ${r.name}`); return stagedForPart; },
  };
}

test('mixed heal: the eligible part (plus superseded items) is healed alone when it changes the repo', async () => {
  const f = fakes(['composer.json']);
  const r = await splitHeal(full, f);
  assert.strictEqual(r.name, 'part');
  assert.deepStrictEqual(f.calls, ['undo full', 'run plugins/clean,plugins/newer', 'stage part']);
});

test('mixed heal: the repo already carries the eligible part -> heal everything, so the rest gets its PR', async () => {
  const f = fakes([]);
  const r = await splitHeal(full, f);
  assert.strictEqual(r.name, 'full again');
  assert.deepStrictEqual(f.calls, ['undo full', 'run plugins/clean,plugins/newer', 'stage part', 'undo part', 'run all']);
});
