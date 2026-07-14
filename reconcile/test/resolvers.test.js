'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeResolvers } = require('../lib/resolvers');

function fakeFetch(map) {
  return async (url) => {
    if (!(url in map)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => map[url] };
  };
}

function fakeRunner(handler) {
  const calls = [];
  return { calls, composer: async (args, opts) => { calls.push({ args, opts }); return handler(args, opts); } };
}

test('wpackagist resolves an existing plugin', async () => {
  const f = fakeFetch({
    'https://api.wordpress.org/plugins/info/1.0/code-snippets.json': { slug: 'code-snippets', version: '3.6.5' },
  });
  const { wpackagist } = makeResolvers({ fetch: f });
  assert.deepStrictEqual(await wpackagist('plugin', 'code-snippets'),
    { source: 'wpackagist-plugin', package: 'wpackagist-plugin/code-snippets', version: '3.6.5' });
});

test('wpackagist returns null on 404 or error payload', async () => {
  const f = fakeFetch({
    'https://api.wordpress.org/plugins/info/1.0/nope.json': { error: 'Plugin not found.' },
  });
  const { wpackagist } = makeResolvers({ fetch: f });
  assert.strictEqual(await wpackagist('plugin', 'nope'), null);
  assert.strictEqual(await wpackagist('plugin', 'missing'), null);
});

test('satispress returns null when no runner is given', async () => {
  const { satispress } = makeResolvers({ fetch: fakeFetch({}) });
  assert.strictEqual(await satispress('anything'), null);
});

test('satispress resolves via `composer show` (reuses the runner\'s own auth.json, no separate credential handling)', async () => {
  const runner = fakeRunner((args) => {
    assert.deepStrictEqual(args, ['show', 'saucal/churn-solution', '--all', '--format=json']);
    return { code: 0, stdout: JSON.stringify({ versions: ['2.x-dev', '2.1.0', '2.0.0'] }), stderr: '' };
  });
  const { satispress } = makeResolvers({ runner, cwd: 'source' });
  const res = await satispress('churn-solution');
  assert.deepStrictEqual(res, { source: 'satispress', package: 'saucal/churn-solution', version: '2.1.0' });
  assert.strictEqual(runner.calls[0].opts.cwd, 'source');
});

test('satispress skips dev/branch-alias entries to find a concrete version', async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: JSON.stringify({ versions: ['dev-main', '3.x-dev', '1.5.2'] }), stderr: '' }));
  const { satispress } = makeResolvers({ runner });
  assert.deepStrictEqual(await satispress('x'), { source: 'satispress', package: 'saucal/x', version: '1.5.2' });
});

test('satispress returns null when composer show fails (package not found / not configured)', async () => {
  const runner = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'Package "saucal/nope" not found.' }));
  const { satispress } = makeResolvers({ runner });
  assert.strictEqual(await satispress('nope'), null);
});

test('satispress returns null on unparseable composer output', async () => {
  const runner = fakeRunner(() => ({ code: 0, stdout: 'not json', stderr: '' }));
  const { satispress } = makeResolvers({ runner });
  assert.strictEqual(await satispress('x'), null);
});
