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

module.exports = { findMergedHeal, pendingOf, pendingOnMerge };
