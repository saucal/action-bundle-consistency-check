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

test('wpackagist resolves an existing plugin', async () => {
  const f = fakeFetch({
    'https://api.wordpress.org/plugins/info/1.0/code-snippets.json': { slug: 'code-snippets', version: '3.6.5' },
  });
  const { wpackagist } = makeResolvers(f, '');
  assert.deepStrictEqual(await wpackagist('plugin', 'code-snippets'),
    { source: 'wpackagist-plugin', package: 'wpackagist-plugin/code-snippets', version: '3.6.5' });
});

test('wpackagist returns null on 404 or error payload', async () => {
  const f = fakeFetch({
    'https://api.wordpress.org/plugins/info/1.0/nope.json': { error: 'Plugin not found.' },
  });
  const { wpackagist } = makeResolvers(f, '');
  assert.strictEqual(await wpackagist('plugin', 'nope'), null);
  assert.strictEqual(await wpackagist('plugin', 'missing'), null);
});

test('satispress resolves from packages.saucal.com p2 metadata', async () => {
  const url = 'https://packages.saucal.com/p2/saucal/churn-solution.json';
  const f = fakeFetch({ [url]: { packages: { 'saucal/churn-solution': [{ version: '2.1.0' }] } } });
  const { satispress } = makeResolvers(f, 'https://packages.saucal.com');
  assert.deepStrictEqual(await satispress('churn-solution'),
    { source: 'satispress', package: 'saucal/churn-solution', version: '2.1.0' });
});

test('satispress returns null when url is empty', async () => {
  const { satispress } = makeResolvers(fakeFetch({}), '');
  assert.strictEqual(await satispress('anything'), null);
});

test('satispress sends Authorization header with an empty password when none is provided', async () => {
  let seenOpts;
  const url = 'https://packages.saucal.com/p2/saucal/churn-solution.json';
  const f = async (u, opts) => {
    seenOpts = opts;
    if (u !== url) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ packages: { 'saucal/churn-solution': [{ version: '2.1.0' }] } }) };
  };
  const { satispress } = makeResolvers(f, 'https://packages.saucal.com', 'SECRET_KEY');
  const res = await satispress('churn-solution');
  assert.strictEqual(res.version, '2.1.0');
  assert.ok(seenOpts && seenOpts.headers && seenOpts.headers.Authorization.startsWith('Basic '));
  const decoded = Buffer.from(seenOpts.headers.Authorization.slice('Basic '.length), 'base64').toString();
  assert.strictEqual(decoded, 'SECRET_KEY:');
});

test('satispress uses the given password (matches composer auth.json convention: token:homepage)', async () => {
  let seenOpts;
  const url = 'https://packages.saucal.com/p2/saucal/churn-solution.json';
  const f = async (u, opts) => {
    seenOpts = opts;
    if (u !== url) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ packages: { 'saucal/churn-solution': [{ version: '2.1.0' }] } }) };
  };
  const { satispress } = makeResolvers(f, 'https://packages.saucal.com', 'SECRET_KEY', 'example.com');
  await satispress('churn-solution');
  const decoded = Buffer.from(seenOpts.headers.Authorization.slice('Basic '.length), 'base64').toString();
  assert.strictEqual(decoded, 'SECRET_KEY:example.com');
});
