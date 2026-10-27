'use strict';
const fs = require('fs');
const path = require('path');
const { generatePatch, upsertExtraPatches } = require('./patch-gen');
const { serializeComposer } = require('./composer');
const { pluginVersion, themeVersion } = require('./extract-version');

/**
 * @param {object} o
 * @param {string} o.projectDir   composer project root
 * @param {string} o.slug         plugin slug (dir name under plugins/)
 * @param {string} o.pkg          composer package name (e.g. saucal/fakeplug)
 * @param {string} o.serverDir    path to the server's (drifted) copy of the plugin dir
 * @param {object} o.runner       makeRunner()-shaped { composer(args,{cwd}) }
 * @param {string} [o.pluginRoot] repo-relative plugin root (default plugins/<slug>)
 * @param {() => Promise<boolean>} [o.ensurePatchSupport] called only once a real residual exists, before the patch is written
 * @param {boolean} [o.allowVersionGap] the server runs a version no registry offers: patch it on top of
 *   the installed (newest published) one, a bridge, instead of stopping at the version mismatch
 * @returns {Promise<{action:'patched'|'bridged'|'bump-only'|'version-mismatch'|'patch-unsupported', patchFile?:string, installed?:string, server?:string}>}
 */
async function reconcilePatched(o) {
  const pluginRoot = o.pluginRoot || `plugins/${o.slug}`;
  const installedDir = path.join(o.projectDir, pluginRoot);
  const composerPath = path.join(o.projectDir, 'composer.json');

  // 0. Drop any existing patch entry for this package so the bump-first reinstall
  //    yields the TRUE published source (cweagans reapplies registered patches on
  //    install/reinstall). Without this, an "already-patched refresh" would diff
  //    against the previously-patched state and the regenerated patch would not
  //    apply cleanly from pristine.
  await dropPatches(o.projectDir, o.pkg, o.runner);

  // 1. Restore pristine published files (bump-first reinstall).
  await o.runner.composer(['reinstall', o.pkg, '--no-progress'], { cwd: o.projectDir });

  // 2. Residual diff: pristine(installed) -> server.
  const patch = generatePatch(installedDir, o.serverDir, pluginRoot);
  if (!patch.trim()) return { action: 'bump-only' };

  // A patch only describes edits ON TOP OF one version: the pristine and server headers must agree.
  const header = pluginRoot.startsWith('themes/') ? themeVersion : pluginVersion;
  const installed = (header(installedDir) || {}).version || null;
  const server = (header(o.serverDir) || {}).version || null;
  const bridge = installed !== server;
  if (bridge && !(o.allowVersionGap && installed && server)) return { action: 'version-mismatch', installed, server };
  if (o.ensurePatchSupport && !(await o.ensurePatchSupport())) return { action: 'patch-unsupported' };

  // 3. Write patch + register in composer.json.
  const patchesDir = path.join(o.projectDir, 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  const patchFile = `./patches/${o.slug}.patch`;
  fs.writeFileSync(path.join(o.projectDir, 'patches', `${o.slug}.patch`), patch);

  const composerText = fs.readFileSync(composerPath, 'utf8');
  const composer = JSON.parse(composerText);
  const { composer: next } = upsertExtraPatches(composer, o.pkg, {
    description: bridge ? `${BRIDGE}v${installed} → v${server} (no published release has it)` : `Reconciled from server drift for ${o.slug}`,
    url: patchFile,
    depth: 2,
  });
  fs.writeFileSync(composerPath, serializeComposer(next, composerText));

  // 4. Relock + apply.
  await o.runner.composer(['patches-relock'], { cwd: o.projectDir });
  await o.runner.composer(['patches-repatch'], { cwd: o.projectDir });

  return { action: bridge ? 'bridged' : 'patched', patchFile, installed, server };
}

// A bridge patch's description starts with this: the next version move drops it (see reconcile-run).
const BRIDGE = 'Bridges ';

/**
 * Remove a package's extra.patches entries and their local patch files, then relock so they're no
 * longer applied. Returns the removed entries.
 */
async function dropPatches(projectDir, pkg, runner) {
  const composerPath = path.join(projectDir, 'composer.json');
  if (!fs.existsSync(composerPath)) return [];
  const text = fs.readFileSync(composerPath, 'utf8');
  const c = JSON.parse(text);
  if (!(c.extra && c.extra.patches && c.extra.patches[pkg])) return [];
  const removed = [].concat(c.extra.patches[pkg]);
  // Its local patch files go too: rewritten if a residual remains, orphaned otherwise.
  for (const e of removed) {
    const url = typeof e === 'string' ? e : e && e.url;
    if (url && /^\.\/patches\/[^/]+$/.test(url)) fs.rmSync(path.join(projectDir, url), { force: true });
  }
  delete c.extra.patches[pkg];
  if (!Object.keys(c.extra.patches).length) delete c.extra.patches;
  fs.writeFileSync(composerPath, serializeComposer(c, text));
  await runner.composer(['patches-relock'], { cwd: projectDir });
  return removed;
}

module.exports = { reconcilePatched, dropPatches, BRIDGE };
