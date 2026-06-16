'use strict';
const fs = require('fs');
const path = require('path');
const { generatePatch, upsertExtraPatches } = require('./patch-gen');

/**
 * @param {object} o
 * @param {string} o.projectDir   composer project root
 * @param {string} o.slug         plugin slug (dir name under plugins/)
 * @param {string} o.pkg          composer package name (e.g. saucal/fakeplug)
 * @param {string} o.serverDir    path to the server's (drifted) copy of the plugin dir
 * @param {object} o.runner       makeRunner()-shaped { composer(args,{cwd}) }
 * @param {string} [o.pluginRoot] repo-relative plugin root (default plugins/<slug>)
 * @returns {Promise<{action:'patched'|'bump-only', patchFile?:string}>}
 */
async function reconcilePatched(o) {
  const pluginRoot = o.pluginRoot || `plugins/${o.slug}`;
  const installedDir = path.join(o.projectDir, pluginRoot);

  // 1. Restore pristine published files (bump-first reinstall).
  await o.runner.composer(['reinstall', o.pkg, '--no-progress'], { cwd: o.projectDir });

  // 2. Residual diff: pristine(installed) -> server.
  const patch = generatePatch(installedDir, o.serverDir, pluginRoot);
  if (!patch.trim()) return { action: 'bump-only' };

  // 3. Write patch + register in composer.json.
  const patchesDir = path.join(o.projectDir, 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  const patchFile = `./patches/${o.slug}.patch`;
  fs.writeFileSync(path.join(o.projectDir, 'patches', `${o.slug}.patch`), patch);

  const composerPath = path.join(o.projectDir, 'composer.json');
  const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
  const { composer: next } = upsertExtraPatches(composer, o.pkg, {
    description: `Reconciled from server drift for ${o.slug}`,
    url: patchFile,
    depth: 2,
  });
  fs.writeFileSync(composerPath, JSON.stringify(next, null, 4) + '\n');

  // 4. Relock + apply.
  await o.runner.composer(['patches-relock'], { cwd: o.projectDir });
  await o.runner.composer(['patches-repatch'], { cwd: o.projectDir });

  return { action: 'patched', patchFile };
}
module.exports = { reconcilePatched };
