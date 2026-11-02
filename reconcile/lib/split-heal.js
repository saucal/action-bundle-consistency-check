'use strict';

/**
 * Mixed heal: merge the part that needs no review now; the rest is deferred, and the next run (which
 * then sees only that) opens a PR for it. When {ref} already carries that part (an earlier heal merged
 * it, not deployed yet) there is nothing to merge now, and every run would defer the rest again without
 * ever opening its PR: heal everything in one PR instead, held as the full heal is (with undeployed
 * commits the caller then builds it as R on the deployed commit, F merging the tip).
 * @param {object} result the full heal (a reconcileRun result)
 * @param {{ runOnce: (only?: Set<string>) => Promise<object>, undo: (r: object) => Promise<void>,
 *   stage: (r: object) => Promise<string[]>, log?: (m: string) => void }} o undo = back to the clean
 *   branch tip, removing what that run wrote; stage = stage its outputs, returning the staged paths
 * @returns {Promise<{result: object, all: boolean}>} the heal to carry on with; all = the full heal (no deferral)
 */
async function splitHeal(result, { runOnce, undo, stage, log = () => {} }) {
  const { eligible } = result.autoMerge;
  await undo(result);
  const part = await runOnce(new Set([...eligible, ...result.classified.filter((c) => c.category === 'superseded').map((c) => c.key)]));
  if ((await stage(part)).length) return { result: part, all: false };
  log(`${eligible.join(', ')}: already on the branch tip, nothing to merge now. One PR carries everything, held for review.`);
  await undo(part);
  return { result: await runOnce(), all: true };
}

module.exports = { splitHeal };
