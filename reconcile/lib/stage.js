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
  // Committed code taken from the server, deletions included (not forced: .gitignore still applies).
  const tracked = new Set(result.trackedPaths || []);
  const adopted = new Set(result.adoptedPaths || []);
  for (const c of result.classified || []) {
    // By path, not category: Pass 5 may relabel an item suspicious after its files were copied.
    const isAdopted = adopted.has(c.adoptedRoot);
    const paths = isAdopted ? [c.adoptedRoot] : (c.paths || []).filter((p) => tracked.has(p));
    if (!paths.length) continue;
    const added = await git(isAdopted ? ['add', '-f', '--', ...paths] : ['add', '-A', '--', ...paths]);
    if (added.code === 0) continue;
    await git(['reset', '-q', '--', ...paths]); // never commit half an item
    c.recoverable = false;
    c.remediation = `${c.key}: the server's copy could not be staged, so no commit carries it. git: ${added.out.trim().split('\n')[0]}`;
  }
  return (await git(['diff', '--cached', '--name-only'])).out.split('\n').filter(Boolean);
}

module.exports = { stageOutputs };
