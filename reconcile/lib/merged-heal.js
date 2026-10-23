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

module.exports = { findMergedHeal, pendingOf };
