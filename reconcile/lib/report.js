'use strict';

const isPatched = (c) => c.category === 'patched' || c.category === 'patched-candidate';
const isAdopted = (c) => c.category === 'adopted' || c.category === 'adopted-lossy';
const OUTSIDE = new Set(['ignorable', 'compiled-asset', 'sensitive']);
// The entry already names the item: drop a leading "<name>: " from its text.
const text = (c) => {
  const r = String(c.remediation || '');
  const name = [c.composerPackage, c.key].find((n) => n && r.startsWith(`${n}: `));
  return name ? r.slice(name.length + 2) : r;
};

// What a reader can do about drift this PR leaves alone, by kind; anything else keeps its own text.
const LEFT_OUT = {
  deferred: () => 'left out of this PR for review; the next run opens a PR for it.',
  'needs-redeploy': () => 'in the build, but missing or different on the server. Not a repo change: the next Deploy puts it back (or ignore it with `SSH_IGNORE_LIST_EXTRA` if the server is right).',
  unknown: () => 'only on the server, and not a plugin, theme or tracked file. Commit it, ignore it, or remove it from the server.',
};

/**
 * @param {import('./classify').Classified[]} classified
 * @param {{ref:string, runUrl:string}} meta
 * @returns {string} markdown PR body: what this PR changes, then the drift it leaves alone
 */
function reportBody(classified, meta) {
  const applied = classified.filter((c) => c.recoverable && !isPatched(c) && !isAdopted(c));
  const patched = classified.filter((c) => c.recoverable && isPatched(c));
  const adopted = classified.filter((c) => c.recoverable && isAdopted(c));
  const inPr = [...applied, ...patched, ...adopted];
  const leftOut = classified.filter((c) => !c.recoverable && !OUTSIDE.has(c.category));
  const ignorable = classified.filter((c) => c.category === 'ignorable');
  const unrecoverable = classified.filter((c) => c.category === 'compiled-asset' || c.category === 'sensitive');

  const residual = inPr.filter((c) => c.verified === false);
  const tag = (c) => c.verified === true ? ' ✅'
    : c.verified === false ? ` ⚠️ ${c.residualFiles} file(s) still differ from the server after this change` : '';

  const L = [`## Server drift on \`${meta.ref}\``, ''];
  if (inPr.length) {
    L.push(`This PR brings ${inPr.length} item(s) in line with the server`
      + (residual.length ? `; ${residual.length} still differ after the change (⚠️).` : inPr.some((c) => c.verified) ? ', each checked to reproduce it (✅).' : '.'));
  }
  const notCovered = leftOut.length + unrecoverable.length;
  if (notCovered) L.push(`${notCovered} drifted item(s) are not covered by it (see below): the check stays red until they're handled.`);
  L.push('', `From the [consistency check run](${meta.runUrl}).`, '');

  if (inPr.length) {
    L.push('### In this PR');
    for (const c of applied) L.push(`- \`${c.composerPackage || c.key}\` — ${text(c)}${tag(c)}`);
    for (const c of patched) L.push(`- 🩹 \`${c.composerPackage || c.key}\` — ${text(c)}${tag(c)}`);
    for (const c of adopted) L.push(`- 📦 \`${c.key}\` — ${text(c)}${tag(c)}`);
    L.push('');
  }
  if (notCovered) {
    L.push('### Not in this PR');
    for (const c of leftOut) L.push(`- \`${c.composerPackage || c.key}\` — ${(LEFT_OUT[c.category] || text)(c)}`);
    for (const c of unrecoverable) L.push(`- ⛔ \`${c.key}\` — ${text(c)}`);
    L.push('');
  }
  if (ignorable.length) {
    L.push(`<details><summary>${ignorable.length} runtime/junk file(s) ignored</summary>`, '');
    for (const c of ignorable) L.push(`- \`${c.key}\` — ${c.remediation}`);
    L.push('', '</details>', '');
  }
  return L.join('\n');
}

module.exports = { reportBody };
