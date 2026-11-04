'use strict';

/**
 * One reconciliation PR per ref, rewritten in place each run. Its body records what it carries, so
 * the next run that rewrites it can leave a trace when that changes.
 */

const MARK = /<!-- self-heal-state: (.*?) -->/g;

/**
 * @param {object[]} classified the items the PR shows
 * @param {{auto: boolean, reasons: string[]}} verdict auto = merged unattended if a build reproduces the server
 */
const prState = (classified, verdict) => ({
  items: [...new Set(classified.filter((c) => c.recoverable).map((c) => c.key))].sort(),
  auto: verdict.auto,
  reasons: verdict.auto ? [] : verdict.reasons,
});

// "--" inside a string would end the HTML comment early: escaped, JSON.parse reads it back.
const stateMarker = (state) => `\n<!-- self-heal-state: ${JSON.stringify(state).replace(/--/g, '\\u002d\\u002d')} -->\n`;

/** The state an earlier run recorded in the PR body, or null (none, or unreadable). */
function readState(body) {
  const m = [...String(body || '').matchAll(MARK)].pop(); // the last: server-derived text above it could fake one
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}

/**
 * The comment for a rewrite that changes what the PR carries or whether it auto-merges; '' when
 * nothing changed, or when the old body recorded no state.
 */
function changeComment(old, now, runUrl) {
  if (!old) return '';
  const left = old.items.filter((k) => !now.items.includes(k));
  const joined = now.items.filter((k) => !old.items.includes(k));
  if (!left.length && !joined.length && old.auto === now.auto) return '';
  const list = (ks) => ks.map((k) => `\`${k}\``).join(', ');
  const verdict = (s, auto = 'auto-merges') => (s.auto ? auto : `held for a human${s.reasons.length ? `: ${s.reasons.join('; ')}` : ''}`);
  return ['Self-heal updated this PR in place:', '',
    ...(left.length ? [`- Left: ${list(left)}`] : []),
    ...(joined.length ? [`- Joined: ${list(joined)}`] : []),
    `- ${old.auto === now.auto ? `Still ${verdict(now)}` : `Was ${verdict(old, 'auto-merging')}; now ${verdict(now)}`}`,
    '', `From the [consistency check run](${runUrl}).`].join('\n');
}

module.exports = { prState, stateMarker, readState, changeComment };
