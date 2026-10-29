'use strict';

/**
 * Mixed heal: merge the part that needs no review now; the rest is deferred, and the next run (which
 * then sees only that) opens a PR for it. When {ref} already carries that part there is nothing to
 * merge now, and every run would defer the rest again without ever opening its PR: heal everything
 * in one PR instead (held, as the full heal is).
 * @param {object} result the full heal (a reconcileRun result)
 * @param {{ runOnce: (only?: Set<string>) => Promise<object>, undo: (r: object) => Promise<void>,
 *   stage: (r: object) => Promise<string[]>, log?: (m: string) => void }} o undo = back to the clean
 *   branch tip, removing what that run wrote; stage = stage its outputs, returning the staged paths
 * @returns {Promise<object>} the heal to carry on with
 */
async function splitHeal(result, { runOnce, undo, stage, log = () => {} }) {
  const { eligible } = result.autoMerge;
  log(`Mixed heal: merging ${eligible.join(', ')} now; the rest waits for the next run's review PR.`);
  await undo(result);
  const part = await runOnce(new Set([...eligible, ...result.classified.filter((c) => c.category === 'superseded').map((c) => c.key)]));
  if ((await stage(part)).length) return part;
  log(`The repo already carries ${eligible.join(', ')}: nothing to merge now, so one PR carries the rest for review.`);
  await undo(part);
  return runOnce();
}

module.exports = { splitHeal };
