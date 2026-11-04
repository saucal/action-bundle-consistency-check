'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Stage ONLY reconcile's outputs (not `git add -A`: Prepare injects build files that aren't source).
 * An item whose files git refuses is no longer recoverable: it is in no commit, so it must be
 * counted and named as drift left, never reported as already carried.
 * @param {string} cwd
 * @param {{classified:object[], trackedPaths?:string[], adoptedPaths?:string[]}} result
 * @param {(p:string)=>boolean} isTracked
 * @param {(args:string[])=>Promise<{code:number,out:string}>} git  runs git in cwd
 * @returns {Promise<string[]>} the staged paths
 */
async function stageOutputs(cwd, result, isTracked, git) {
  // Not .patches_applied: the local "patches already applied" marker. Committed, a fresh build
  // sees a matching hash and never reinstalls the patched packages, so patches don't apply.
  const OUTPUT_PATHS = ['composer.json', 'composer.lock', 'patches', 'patches.lock.json', '.gitignore'];
  // Tracked-but-gone counts too: a withdrawn last patch deletes patches/ and patches.lock.json.
  const toStage = OUTPUT_PATHS.filter((p) => fs.existsSync(path.join(cwd, p)) || isTracked(p));
  if (toStage.length) await git(['add', '-A', '--', ...toStage]);
  // Force-add adopted (vendored) component dirs — plugins/ is typically gitignored for
  // composer-managed installs, so a plain `git add` would skip the newly-vendored source.
  // Committed code taken from the server, deletions included. Forced too: a root adopted under an
  // ignored parent stays ignored, so its new files would be refused (a file the root's .gitignore
  // excludes on purpose is then committed as well, once the server changes it).
  const tracked = new Set(result.trackedPaths || []);
  const adopted = new Set(result.adoptedPaths || []);
  for (const c of result.classified || []) {
    // By path, not category: Pass 5 may relabel an item suspicious after its files were copied.
    const isAdopted = adopted.has(c.adoptedRoot);
    const paths = isAdopted ? [c.adoptedRoot] : (c.paths || []).filter((p) => tracked.has(p));
    if (!paths.length) continue;
    const added = await git(isAdopted ? ['add', '-f', '--', ...paths] : ['add', '-A', '-f', '--', ...paths]);
    if (added.code === 0) continue;
    await git(['reset', '-q', '--', ...paths]); // never commit half an item
    c.recoverable = false;
    // git names the refused paths after its header line, then adds "hint:" lines.
    const [why = '', ...refused] = added.out.trim().split('\n').filter((l) => l && !l.startsWith('hint:'));
    c.remediation = /ignored by/.test(why) && refused.length
      ? `${c.key}: the server's copy could not be staged, so no commit carries it: .gitignore ignores ${refused.map((p) => `\`${p}\``).join(', ')}. **To match:** re-include it in .gitignore (a \`!\` rule), or add it to \`SSH_IGNORE_LIST_EXTRA\` if the server's copy should stay out of the repo.`
      : `${c.key}: the server's copy could not be staged, so no commit carries it. git: ${why}`;
    // Decided before staging: an item no commit carries holds nothing. Its security notes stay (the files are still on the server), labelled.
    if (result.autoMerge) result.autoMerge.reasons = result.autoMerge.reasons.filter((r) => !r.startsWith(`${c.key}: `));
    for (const h of (result.security && result.security.warn) || []) if (h.key === c.key) h.notInPr = true;
  }
  return (await git(['diff', '--cached', '--name-only'])).out.split('\n').filter(Boolean);
}

/**
 * A mixed heal's rerun defers every item run 1 did not merge; one git refused in run 1 keeps run 1's
 * entry: drift left that needs a decision, never "the next run opens a PR" (no run can stage it).
 * @param {object[]} classified  the rerun's
 * @param {object[]} refused  run 1's entries stageOutputs made unrecoverable
 */
const keepRefused = (classified, refused) => classified.map((c) => (c.category === 'deferred' && refused.find((r) => r.key === c.key)) || c);

module.exports = { stageOutputs, keepRefused };
