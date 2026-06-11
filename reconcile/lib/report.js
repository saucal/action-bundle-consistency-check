'use strict';
const { decideOutcome } = require('./outcome');

/**
 * @param {import('./classify').Classified[]} classified
 * @param {{ref:string, runUrl:string}} meta
 * @returns {string} markdown PR body
 */
function reportBody(classified, meta) {
  const outcome = decideOutcome(classified);
  const applied = classified.filter((c) => c.recoverable);
  const ignorable = classified.filter((c) => c.category === 'ignorable');
  const unrecoverable = classified.filter((c) => c.category === 'compiled-asset' || c.category === 'sensitive');
  const needsReview = classified.filter((c) =>
    !c.recoverable && c.category !== 'ignorable' && c.category !== 'compiled-asset' && c.category !== 'sensitive');

  const L = [];
  L.push(`## Consistency reconciliation — \`${meta.ref}\``);
  L.push('');
  L.push(`**Outcome:** ${outcome}`);
  L.push('');
  L.push(`Generated from the [consistency check run](${meta.runUrl}). The server filesystem drifted from the deployed build; this PR captures the recoverable changes back into source.`);
  L.push('');
  pushSection(L, '✅ Applied (in this PR)', applied, (c) => `\`${c.composerPackage || c.key}\` — ${c.remediation}`);
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
