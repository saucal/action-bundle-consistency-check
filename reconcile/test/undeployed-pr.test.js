'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tipBranchOf, tipTitle, engineerLogins, tipNote } = require('../lib/undeployed-pr');

test('the undeployed-tip PR never looks like a reconciliation to Deploy', () => {
  assert.ok(!tipBranchOf('main').startsWith('reconciliation-'));
  assert.ok(!/\[commit only\]|\[skip deploy\]/.test(tipTitle('main')));
  assert.ok(!tipTitle('main').startsWith('Reconcile server drift on '));
});

test('engineers: authors and committers, deduped, without the token user, web-flow or bots', () => {
  assert.deepStrictEqual(engineerLogins('alice\nweb-flow\nbob\nalice\nsaucal-ci\ndependabot[bot]\n\n', 'saucal-ci'), ['alice', 'bob']);
  assert.deepStrictEqual(engineerLogins('{"message":"Not Found"}'), []);
});

test('the note names the engineers, or says to assign by hand', () => {
  const o = { commits: 2, since: 'a'.repeat(40), rm: 'b'.repeat(40) };
  assert.match(tipNote('main', { ...o, logins: ['alice', 'bob'] }), /@alice, @bob/);
  assert.match(tipNote('main', { ...o, logins: [] }), /assign this PR by hand/);
  assert.match(tipNote('main', { ...o, logins: [] }), /never merged automatically/);
});
