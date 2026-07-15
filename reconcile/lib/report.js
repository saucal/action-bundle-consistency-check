'use strict';
const { decideOutcome } = require('./outcome');

/**
 * @param {import('./classify').Classified[]} classified
 * @param {{ref:string, runUrl:string}} meta
 * @returns {string} markdown PR body
 */
function reportBody(classified, meta) {
  const outcome = decideOutcome(classified);
  const isPatched = (c) => c.category === 'patched' || c.category === 'patched-candidate';
  const isAdopted = (c) => c.category === 'adopted' || c.category === 'adopted-lossy';
  const applied = classified.filter((c) => c.recoverable && !isPatched(c) && !isAdopted(c));
  const patched = classified.filter(isPatched);
  const adopted = classified.filter(isAdopted);
  const ignorable = classified.filter((c) => c.category === 'ignorable');
  const unrecoverable = classified.filter((c) => c.category === 'compiled-asset' || c.category === 'sensitive');
  const needsReview = classified.filter((c) =>
    !c.recoverable && c.category !== 'ignorable' && c.category !== 'compiled-asset' && c.category !== 'sensitive');

  // Verification (where we land): recovered components byte-compared against the captured server
  // state. verified = a deploy reproduces the server; residual = still differs after apply.
  const verifiable = classified.filter((c) => c.verified !== undefined);
  const okCount = verifiable.filter((c) => c.verified).length;
  const verifyLine = meta.verify || (verifiable.length
    ? `verified ${okCount}/${verifiable.length} recovered components reproduce the server`
      + (okCount < verifiable.length ? ' — residual drift remains, see below' : ' byte-for-byte')
    : '');
  const tag = (c) => c.verified === true ? '  ✅ verified — reproduces the server'
    : c.verified === false ? `  ⚠️ residual — ${c.residualFiles} file(s) still differ after apply` : '';

  const L = [];
  L.push(`## Consistency reconciliation — \`${meta.ref}\``);
  L.push('');
  L.push(`**Outcome:** ${outcome}${verifyLine ? ` (${verifyLine})` : ''}`);
  L.push('');
  L.push(`Generated from the [consistency check run](${meta.runUrl}). The server filesystem drifted from the deployed build; this PR captures the recoverable changes back into source. Recovered items are byte-compared against the live server state captured during the check — see the ✅/⚠️ tags.`);
  L.push('');
  pushSection(L, '✅ Applied (in this PR)', applied, (c) => `\`${c.composerPackage || c.key}\` — ${c.remediation}${tag(c)}`);
  pushSection(L, '🩹 Patched (modified from published)', patched, (c) => `\`${c.composerPackage || c.key}\` — ${c.remediation}${tag(c)}`);
  pushSection(L, '📦 Adopted (vendored into repo)', adopted, (c) => `\`${c.key}\` — ${c.remediation}${tag(c)}`);
  pushSection(L, '⚠️ Needs review', needsReview, (c) => `\`${c.key}\` — ${c.remediation}`);
  pushSection(L, '🧹 Ignorable (no source change)', ignorable, (c) => `\`${c.key}\` — ${c.remediation}`);
  pushSection(L, '⛔ Unrecoverable', unrecoverable, (c) => `\`${c.key}\` — ${c.remediation}`);
  return L.join('\n');
}

function pushSection(L, title, items, fmt) {
  if (!items.length) return;
  L.push(`### ${title}`);
  for (const it of items) L.push(`- ${fmt(it)}`);
  L.push('');
}

module.exports = { reportBody };
