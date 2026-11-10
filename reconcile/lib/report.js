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
  for (const c of classified.filter((x) => x.vulnsSummarized)) {
    L.push(`<details><summary>Known vulnerabilities: ${c.vulns.length} in ${name(c)} at v${c.vulnVersion || '?'}</summary>`, '');
    for (const v of c.vulns) {
      const id = v.cve || v.id;
      L.push(`- ${v.url ? `[${id}](${v.url})` : `\`${id}\``}${v.title ? ` — ${v.title}` : ''}${v.fixed_in ? ` (fixed in v${v.fixed_in})` : ' (no fix listed)'}`);
    }
    L.push('', '</details>', '');
  }
  return L.join('\n');
}

/** The drift a run leaves, for its failure message: what needs a decision vs what follows by itself ('' if none). `named` lists the items. */
function remaining(classified, named = false) {
  const left = classified.filter((c) => !c.recoverable && c.category !== 'ignorable');
  const later = left.filter((c) => LATER.has(c.category)).map((c) => c.key);
  const decide = left.filter((c) => !LATER.has(c.category)).map((c) => c.key);
  const names = (keys) => (named ? ` (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ` and ${keys.length - 5} more` : ''})` : '');
  return [decide.length && `${decide.length} item(s) need a decision${names(decide)}`, later.length && `${later.length} item(s) ${WAIT}${names(later)}`].filter(Boolean).join(', ');
}

/** The failure of a run that opened or updated a PR but left drift (`left` = remaining(…, true)): names the PR. */
const remainsFailure = (left, pr, url) => `Reconciliation ran, but drift remains: ${left}${pr ? `; see PR #${pr}: ${url}` : ' — see the job summary.'}`;

/** The held PR's auto-merge line: its reasons as a list, else where the body lists them. */
const heldNote = (reasonLines) => `**Auto-merge:** held for a human${reasonLines ? `:\n\n${reasonLines}` : " — see “Repo changes this PR can't make”."}\n\n`;

/**
 * Banner of a PR built on the last deployed commit. Only the repo changes that need a decision keep
 * the check failing, so the next Deploy does not go through either; deferred/superseded ones don't.
 */
const undeployedNote = (ref, pending, classified) => {
  const open = classified.filter((c) => !c.recoverable && c.category !== 'ignorable' && !LATER.has(c.category)).length;
  return `**Undeployed commits:** \`${ref}\` has ${pending.commits} commit(s) not deployed yet (since \`${pending.since.slice(0, 7)}\`). `
  + `This PR makes the repo changes on that commit first (the server's state, which the built repo records on merge), then merges those ${pending.commits} on top: they stay undeployed until the next Deploy, `
  + (open ? `which the consistency check still stops until the ${open} repo change(s) that need a decision are made.\n\n` : 'which then goes through.\n\n');
};

/** The heal commit's explanation: only a PR the gate merges was verified before merging. */
const healCommitLine = (gated) => (gated
  ? 'Brings the repo in line with the server; verified to reproduce it before merging.'
  : 'Brings the repo in line with the server. Merged by hand, so not verified beforehand: the Deploy this merge triggers records it only if its dry run changes nothing.');

/** The failure when nothing was staged. Recovery path (head-sha set): the repo is done, only the built repo is behind. Else it names what is left. */
const noCommitFailure = (outcome, ref, recording, classified = []) => {
  if (recording) return `Consistency drift: ${ref} already carries every repo change; the verify job records its build on the built repo.`;
  const open = remaining(classified, true);
  return open ? `Drift remains: ${open}. See the job summary.` : `Consistency drift produced no committable source change (${outcome}).`;
};

/** A merged heal not yet recorded: claims the record only while nothing is left (`open` = remaining()); the verify job's record is refused until then. */
const recordNotice = (ref, sha, rec, open) => `${ref} already has the server's state in ${sha.slice(0, 7)}, merged but not recorded in the built repo: `
  + (open ? `the record (${rec.slice(0, 7)}) waits until the item(s) left in the job summary are settled` : `recording ${rec === sha ? 'it' : `its merge ${rec.slice(0, 7)}`}`)
  + '. No PR, nothing deployed.';

module.exports = { reportBody, heldNote, undeployedNote, healCommitLine, noCommitFailure, remaining, remainsFailure, recordNotice };
