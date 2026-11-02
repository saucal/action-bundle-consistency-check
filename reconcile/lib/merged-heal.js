'use strict';

/**
 * The newest heal ("Reconcile server drift on {ref} … [commit only]") in `git log --no-merges
 * --format=%H%x09%s` output, newest first. A merge-button commit only quotes the title in its body,
 * so merges are left out by the caller; a squash adds " (#N)" to the subject.
 * @returns {string} its sha, or '' when none
 */
function findMergedHeal(logOut, ref) {
  for (const line of String(logOut).split('\n')) {
    const [sha, subject = ''] = line.split('\t');
    if (subject.startsWith(`Reconcile server drift on ${ref} `) && subject.includes('[commit only]')) return sha;
  }
  return '';
}

/** A commit message's "Self-heal-pending:" paths, one per line. */
const pendingOf = (message) => String(message).split('\n').filter((l) => l.startsWith('Self-heal-pending: ')).map((l) => l.slice(19).trim()).join('\n');

/**
 * The paths a heal's merge leaves on the server as they are. Merged unattended, that is what it did not
 * apply; merged by hand (auto-merge off, or held), the PR carries everything it applies, held items included.
 */
const pendingOnMerge = (autoMergeOn, autoMerge) => (autoMergeOn && autoMerge.ok ? autoMerge.pending : autoMerge.open);

/**
 * Items the heal on the tip (run A) recovers that the heal on the deployed commit (run B) does not:
 * run B is what gets built and recorded, so pushing anyway would record a parity commit without them.
 * Run A's superseded items are not recoverable there, so they never count.
 * @returns {object[]} run B's entry for each (or run A's when run B has none)
 */
function lostInRunB(tipClassified, classified) {
  const b = new Map(classified.map((c) => [c.key, c]));
  return tipClassified.filter((c) => c.recoverable && !(b.get(c.key) || {}).recoverable).map((c) => b.get(c.key) || c);
}

/** Both runs scan the same server files: list each finding once. */
const uniqHits = (hits) => [...new Map(hits.map((h) => [JSON.stringify(h), h])).values()];

/**
 * The security findings and auto-merge verdict of a heal: run B's alone, or with undeployed commits
 * (tipResult = run A) both runs' findings — run B assesses patches for superseded items run A never
 * made — and run B's verdict, never ok while either run found compromise signals.
 */
function combineRuns(tipResult, result) {
  if (!tipResult) return { security: result.security, autoMerge: result.autoMerge };
  const security = { critical: uniqHits([...tipResult.security.critical, ...result.security.critical]), warn: uniqHits([...tipResult.security.warn, ...result.security.warn]) };
  const autoMerge = { ...result.autoMerge, ok: result.autoMerge.ok && !security.critical.length,
    reasons: [...new Set([...tipResult.autoMerge.reasons, ...result.autoMerge.reasons])] };
  return { security, autoMerge };
}

module.exports = { findMergedHeal, pendingOf, pendingOnMerge, lostInRunB, combineRuns };
