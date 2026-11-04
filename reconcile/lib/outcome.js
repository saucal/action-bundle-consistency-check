'use strict';
const { remaining } = require('./report');

/**
 * @param {import('./classify').Classified[]} classified
 * @returns {'reconciled'|'partial'|'unrecoverable-only'|'ignorable-only'|'noop'}
 */
function decideOutcome(classified) {
  const recoverable = classified.filter((c) => c.recoverable);
  const ignorable = classified.filter((c) => c.category === 'ignorable');
  const unrecoverable = classified.filter((c) => !c.recoverable && c.category !== 'ignorable');

  if (recoverable.length && unrecoverable.length) return 'partial';
  if (recoverable.length) return 'reconciled';
  if (unrecoverable.length) return 'unrecoverable-only';
  if (ignorable.length) return 'ignorable-only';
  return 'noop';
}

/**
 * End a run that stages nothing. Recovery (the branch already matches the server, only the built
 * repo's record is behind) warns and outputs recovery=true, so action.yml keeps the job green;
 * anything else fails it.
 */
function endRun(core, message, recovery) {
  if (!recovery) { core.setFailed(message); return; }
  core.setOutput('recovery', 'true');
  core.warning(message);
}

/** Recovery needs the built record to lag AND nothing left to decide or wait for: a lagging record alone is not one. */
const isRecovery = (recording, classified) => !!recording && !remaining(classified);

module.exports = { decideOutcome, endRun, isRecovery };
