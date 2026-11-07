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

// A merged engineers' PR leaves nothing for its branch to keep reachable: the next check deletes it,
// but only while the branch adds nothing to {ref} (an unanswered compare never deletes).
test('a merged engineers\' PR has its branch deleted once {ref} contains it', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const rec = src.slice(src.indexOf('async function recoverTipPr'), src.indexOf('async function routeTipPr'));
  assert.match(rec, /closed && closed\.merged[\s\S]{0,600}contains\(repo, at, ref\)\) === true[\s\S]{0,200}'DELETE', `repos\/\$\{repo\}\/git\/refs\/heads\/\$\{tipBranch\}`/);
});
