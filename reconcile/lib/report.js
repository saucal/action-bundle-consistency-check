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

// Drift this PR leaves alone, as the repo change that would match the server. Anything else keeps its own text.
const IGNORE = '`SSH_IGNORE_LIST_EXTRA`';
const LEFT_OUT = {
  deferred: (c) => `left out of this PR for review${c.held ? ` (${c.held})` : ''}; the next run opens a PR for it.`,
  'needs-redeploy': (c) => (c.onServer
    ? `changed on the server, but the build adds it (composer or mu-plugins), so the repo has no copy to change. **To match:** make the change where it comes from, or add it to ${IGNORE} if the server's copy should stay as it is.`
    : c.onServer === false
      ? `in the build, not on the server. **To match:** add it to ${IGNORE} so the build's copy stops counting. Not done here: the build adds it (composer or mu-plugins), so the repo has no file to delete.`
      : text(c)),
  unknown: () => `on the server, not in the repo. **To match:** commit it, or add it to ${IGNORE} if it's data a plugin writes at runtime. Not done here: reconcile can't tell code the repo should own from runtime data.`,
};

/**
 * Written for the engineer making the repo match the server: what happened on the server → the repo
 * change, first the ones this PR makes, then the ones it can't.
 * @param {import('./classify').Classified[]} classified
 * @param {{ref:string, runUrl:string, already?:string|true}} meta  already: {ref} carries every repo change
 *   already (no PR): the merged heal's sha, or true when they're in commits not deployed yet
 * @returns {string} markdown PR body
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
  const name = (c) => (c.key === 'wordpress-core' ? 'WordPress core' : `\`${c.composerPackage || c.key}\``);

  const notCovered = leftOut.length + unrecoverable.length;
  const total = inPr.length + notCovered;
  const L = [`## Make \`${meta.ref}\` match the server`, ''];
  if (total) {
    const ok = inPr.filter((c) => c.verified).length; // removals have nothing left to compare: never verified
    const checked = residual.length ? `; ${residual.length} still differ after the change (⚠️)`
      : ok && ok === inPr.length ? ' (each checked against the server\'s files ✅)' : ok ? ` (${ok} checked against the server's files ✅)` : '';
    const open = notCovered ? ` ${notCovered} need a decision (below), and the check stays red until they're made.` : '';
    L.push(meta.already && !inPr.length
      ? `No repo change would bring \`${meta.ref}\` closer to the server, so there's no PR.${open}`
      : meta.already
      ? `\`${meta.ref}\` already has the ${inPr.length} repo change(s) that match the server, so there's no PR. `
        + (meta.already === true ? 'They are in commits not deployed yet: the next Deploy ships them.'
          : `They came in with \`${meta.already.slice(0, 7)}\`, whose build was never recorded in the built repo: this run records it there, without deploying.`) + open
      : `The server no longer matches \`${meta.ref}\`: ${total} repo change(s) would make them match. `
        + (!notCovered ? `This PR makes all of them${checked}.`
          : `This PR makes ${inPr.length}${checked}; ${notCovered} need a decision (below), and the check stays red until they're made.`));
  }
  L.push('', `From the [consistency check run](${meta.runUrl}).`, '');

  if (inPr.length) {
    L.push(meta.already ? `### Already in \`${meta.ref}\`` : '### Repo changes in this PR');
    for (const c of applied) L.push(`- ${name(c)} — ${text(c)}${tag(c)}`);
    for (const c of patched) L.push(`- 🩹 ${name(c)} — ${text(c)}${tag(c)}`);
    for (const c of adopted) L.push(`- 📦 \`${c.key}\` — ${text(c)}${tag(c)}`);
    L.push('');
  }
  if (notCovered) {
    L.push(meta.already ? '### Repo changes still to make' : '### Repo changes this PR can\'t make');
    for (const c of leftOut) L.push(`- ${name(c)} — ${(LEFT_OUT[c.category] || text)(c)}`);
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

/** The held PR's auto-merge line: its reasons as a list, else where the body lists them. */
const heldNote = (reasonLines) => `**Auto-merge:** held for a human${reasonLines ? `:\n\n${reasonLines}` : " — see “Repo changes this PR can't make”."}\n\n`;

/**
 * Banner of a PR built on the last deployed commit. open: the repo changes it can't make — while
 * any remain, the check still fails, so the next Deploy does not go through either.
 */
const undeployedNote = (ref, pending, open) => `**Undeployed commits:** \`${ref}\` has ${pending.commits} commit(s) not deployed yet (since \`${pending.since.slice(0, 7)}\`). `
  + `This PR makes the repo changes on that commit first (the server's state, which the built repo records on merge), then merges those ${pending.commits} on top: they stay undeployed until the next Deploy, `
  + (open ? `which the consistency check still stops until the ${open} repo change(s) this PR can't make are dealt with.\n\n` : 'which then goes through.\n\n');

/** The heal commit's explanation: only a PR the gate merges was verified before merging. */
const healCommitLine = (gated) => (gated
  ? 'Brings the repo in line with the server; verified to reproduce it before merging.'
  : 'Brings the repo in line with the server. Merged by hand, so not verified beforehand: the Deploy this merge triggers records it only if its dry run changes nothing.');

module.exports = { reportBody, heldNote, undeployedNote, healCommitLine };
