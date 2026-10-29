'use strict';

const isPatched = (c) => c.category === 'patched' || c.category === 'patched-candidate';
const isAdopted = (c) => c.category === 'adopted' || c.category === 'adopted-lossy';
const OUTSIDE = new Set(['ignorable', 'compiled-asset', 'sensitive']);
// Left out now, but nothing to decide: the next run opens their PR, or the next Deploy ships the repo's version.
const LATER = new Set(['deferred', 'superseded']);
const WAIT = "wait for the next run's PR or the next Deploy";
// The entry already names the item: drop a leading "<name>: " from its text.
const text = (c) => {
  const r = String(c.remediation || '');
  const name = [c.composerPackage, c.key].find((n) => n && r.startsWith(`${n}: `));
  return name ? r.slice(name.length + 2) : r;
};

// Drift this PR leaves alone, as the repo change that would match the server. Anything else keeps its own text.
const IGNORE = '`SSH_IGNORE_LIST_EXTRA`';
const LEFT_OUT = {
  deferred: () => 'left out of this PR for review; the next run opens a PR for it.',
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
    const checked = residual.length ? `; ${residual.length} still differ after the change (⚠️)` : inPr.some((c) => c.verified) ? ' (each checked against the server\'s files ✅)' : '';
    const later = leftOut.filter((c) => LATER.has(c.category)).length;
    const decide = notCovered - later;
    const open = (decide ? ` ${decide} need a decision (below), and the check stays red until they're made.` : '') + (later ? ` ${later} ${WAIT} (below).` : '');
    L.push(meta.already && !inPr.length
      ? `No repo change would bring \`${meta.ref}\` closer to the server, so there's no PR.${open}`
      : meta.already
      ? `\`${meta.ref}\` already has the ${inPr.length} repo change(s) that match the server, so there's no PR. `
        + (meta.already === true ? 'They are in commits not deployed yet: the next Deploy ships them.'
          : `They came in with \`${meta.already.slice(0, 7)}\`, whose build was never recorded in the built repo: this run records it there, without deploying.`) + open
      : `The server no longer matches \`${meta.ref}\`: ${total} repo change(s) would make them match. `
        + (!notCovered ? `This PR makes all of them${checked}.`
          : `This PR makes ${inPr.length}${checked};${open}`));
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

/** The drift a run leaves, for its failure message: what needs a decision vs what follows by itself ('' if none). */
function remaining(classified) {
  const left = classified.filter((c) => !c.recoverable && c.category !== 'ignorable');
  const later = left.filter((c) => LATER.has(c.category)).length;
  return [left.length - later && `${left.length - later} item(s) need a decision`, later && `${later} item(s) ${WAIT}`].filter(Boolean).join(', ');
}

module.exports = { reportBody, remaining };
