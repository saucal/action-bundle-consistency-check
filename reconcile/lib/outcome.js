'use strict';

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

module.exports = { decideOutcome };
