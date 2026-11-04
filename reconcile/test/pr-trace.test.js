'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prState, stateMarker, readState, changeComment } = require('../lib/pr-trace');

const held = { items: ['classic-editor', 'twentytwentyfive'], auto: false, reasons: ['classic-editor: bridge patch changes the version'] };
const auto = { items: ['twentytwentyfive'], auto: true, reasons: [] };

test('prState: the recoverable items, sorted and unique; reasons only while held', () => {
  const classified = [{ key: 'b', recoverable: true }, { key: 'a', recoverable: true }, { key: 'x', recoverable: false }, { key: 'a', recoverable: true }];
  assert.deepStrictEqual(prState(classified, { auto: false, reasons: ['b: CVE'] }), { items: ['a', 'b'], auto: false, reasons: ['b: CVE'] });
  assert.deepStrictEqual(prState(classified, { auto: true, reasons: ['ignored'] }), { items: ['a', 'b'], auto: true, reasons: [] });
});

test('stateMarker/readState: round trip, "--" included; null without a readable marker', () => {
  const s = { items: ['plugins/a--b'], auto: false, reasons: ['plugins/a--b: x --> y'] };
  const body = `# PR\n${stateMarker(s)}`;
  assert.strictEqual(body.indexOf('-->'), body.lastIndexOf('-->')); // only the marker's own end
  assert.deepStrictEqual(readState(body), s);
  assert.strictEqual(readState('no marker'), null);
  assert.strictEqual(readState('<!-- self-heal-state: {nope -->'), null);
  assert.strictEqual(readState(undefined), null);
  assert.deepStrictEqual(readState(`<!-- self-heal-state: {"items":[],"auto":true,"reasons":[]} -->\n${body}`), s); // the appended one wins
});

test('changeComment: nothing changed, or no recorded state -> no comment', () => {
  assert.strictEqual(changeComment(held, { ...held, items: [...held.items] }, 'u'), '');
  assert.strictEqual(changeComment(null, auto, 'u'), '');
});

test('changeComment: a held PR rewritten into an auto-merging one names what left and the verdict change', () => {
  assert.strictEqual(changeComment(held, auto, 'https://run'), [
    'Self-heal updated this PR in place:', '',
    '- Left: `classic-editor`',
    '- Was held for a human: classic-editor: bridge patch changes the version; now auto-merges',
    '', 'From the [consistency check run](https://run).'].join('\n'));
});

test('changeComment: items joining with the verdict unchanged; auto -> held', () => {
  const c = changeComment(auto, held, 'u');
  assert.match(c, /^- Joined: `classic-editor`$/m);
  assert.doesNotMatch(c, /Left:/);
  assert.match(c, /^- Was auto-merging; now held for a human: classic-editor: bridge patch changes the version$/m);
  const still = changeComment({ ...held, items: ['classic-editor'] }, held, 'u');
  assert.match(still, /^- Joined: `twentytwentyfive`\n- Still held for a human: classic-editor: /m);
});
