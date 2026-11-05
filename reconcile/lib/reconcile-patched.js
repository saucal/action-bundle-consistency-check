'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generatePatch, upsertExtraPatches, patchEntries, isHealEntry } = require('./patch-gen');
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
 * @returns {Promise<{action:'patched'|'bridged'|'bump-only'|'version-mismatch'|'patch-unsupported'|'needs-resolution', patchFile?:string, dropped?:string[], kept?:string[], installed?:string, server?:string}>}
 */
async function reconcilePatched(o) {
  const pluginRoot = o.pluginRoot || `plugins/${o.slug}`;
  const installedDir = path.join(o.projectDir, pluginRoot);
  const composerPath = path.join(o.projectDir, 'composer.json');

  // Patches the heal did not write (a developer's) are never replaced: the heal's own patch is cut
  // on top of them. One the server no longer carries (undone, or edited over) needs a human.
  const composerBefore = fs.existsSync(composerPath) ? fs.readFileSync(composerPath, 'utf8') : '';
  const kept = patchEntries(((composerBefore ? JSON.parse(composerBefore) : {}).extra || {}).patches?.[o.pkg])
    .filter((e) => !isHealEntry(e, o.slug));
  const keptUrls = kept.map(urlOf);
  if (kept.length) {
    const lost = kept.filter((e) => !serverCarries(o.projectDir, o.serverDir, e)).map(urlOf);
    if (lost.length) return { action: 'needs-resolution', patches: lost, kept: keptUrls };
  }

  // 0. Drop the heal's own patch entry for this package so the bump-first reinstall
  //    yields the published source plus the kept patches only (cweagans reapplies registered
  //    patches on install/reinstall). Without this, an "already-patched refresh" would diff
  //    against the previously-patched state and the regenerated patch would not apply.
  //    Remember the entry order first: the re-cut entry goes back where it was, not last.
  const patchOrder = composerBefore ? Object.keys((JSON.parse(composerBefore).extra || {}).patches || {}) : [];
  const healFile = path.join(o.projectDir, 'patches', `${o.slug}.patch`);
  const healBefore = fs.existsSync(healFile) ? fs.readFileSync(healFile) : null;
  const dropped = (await dropPatches(o.projectDir, o.pkg, o.runner, o.slug)).map(urlOf).filter(Boolean);
  // A kept patch that no longer fits: put the heal's earlier patch back and hand it to a human.
  const unresolved = async (patches) => {
    fs.writeFileSync(composerPath, composerBefore);
    if (healBefore) fs.writeFileSync(healFile, healBefore); else fs.rmSync(healFile, { force: true });
    await o.runner.composer(['patches-relock'], { cwd: o.projectDir });
    await o.runner.composer(['reinstall', o.pkg, '--no-progress'], { cwd: o.projectDir });
    return { action: 'needs-resolution', patches, kept: keptUrls };
  };

  // 1. Restore published files + kept patches (bump-first reinstall). It fails when a kept patch
  //    no longer applies (e.g. Pass 1 moved the version).
  const re = await o.runner.composer(['reinstall', o.pkg, '--no-progress'], { cwd: o.projectDir });
  if (kept.length && re && re.code !== 0) return unresolved(keptUrls);

  // 2. Residual diff: published + kept patches (installed) -> server.
  const patch = generatePatch(installedDir, o.serverDir, pluginRoot);
  if (!patch.trim()) return { action: 'bump-only', dropped, kept: keptUrls };

  // A patch only describes edits ON TOP OF one version: the pristine and server headers must agree.
  const header = pluginRoot.startsWith('themes/') ? themeVersion : pluginVersion;
  const installed = (header(installedDir) || {}).version || null;
  const server = (header(o.serverDir) || {}).version || null;
  const bridge = installed !== server;
  if (bridge && !(o.allowVersionGap && installed && server)) return { action: 'version-mismatch', installed, server };
  if (o.ensurePatchSupport && !(await o.ensurePatchSupport())) return { action: 'patch-unsupported' };
  const edits = bridge ? localEdits(patch) : null;

  // 3. Write patch + register in composer.json.
  const patchesDir = path.join(o.projectDir, 'patches');
  fs.mkdirSync(patchesDir, { recursive: true });
  const patchFile = `./patches/${o.slug}.patch`;
  fs.writeFileSync(path.join(o.projectDir, 'patches', `${o.slug}.patch`), patch);

  const composerText = fs.readFileSync(composerPath, 'utf8');
  const composer = JSON.parse(composerText);
  const { composer: next } = upsertExtraPatches(composer, o.pkg, {
    description: bridge
      ? `${BRIDGE}v${installed} → v${server}${edits.files.length ? ` + local edits (${edits.lines} line${edits.lines === 1 ? '' : 's'})` : ''} (no published release has it)`
      : `Reconciled from server drift for ${o.slug}`,
    url: patchFile,
    depth: 2,
  });
  // patches-relock writes patches.lock.json in this same order.
  const p = next.extra.patches;
  const keys = [...patchOrder.filter((k) => k in p), ...Object.keys(p).filter((k) => !patchOrder.includes(k))];
  next.extra.patches = Object.fromEntries(keys.map((k) => [k, p[k]]));
  fs.writeFileSync(composerPath, serializeComposer(next, composerText));

  // 4. Relock + apply.
  await o.runner.composer(['patches-relock'], { cwd: o.projectDir });
  await o.runner.composer(['patches-repatch'], { cwd: o.projectDir });
  // The heal's patch must land on top of the kept ones (repatch's exit code doesn't say so).
  if (kept.length && generatePatch(installedDir, o.serverDir, pluginRoot).trim()) return unresolved([...keptUrls, patchFile]);

  const k = kept.length ? { kept: keptUrls } : {};
  return bridge ? { action: 'bridged', patchFile, installed, server, localEdits: edits, ...k } : { action: 'patched', patchFile, installed, server, ...k };
}

const urlOf = (e) => (typeof e === 'string' ? e : e && e.url);

/**
 * True when the server's copy still carries a local patch: it reverse-applies there. A patch that
 * isn't a local file can't be checked, so it counts as not carried (held, never assumed).
 */
function serverCarries(projectDir, serverDir, entry) {
  const url = urlOf(entry);
  const file = url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? path.resolve(projectDir, url) : null;
  if (!file || !fs.existsSync(file)) return false;
  try {
    // The ceiling keeps git from finding the repo serverDir sits in: inside one, paths outside the
    // cwd are skipped and the check passes having applied nothing.
    // shortcut: an entry without depth is checked at -p1 (cweagans' default); a project-wide
    // default-patch-depth isn't read, so such a patch is held (the safe side), not passed.
    execFileSync('git', ['apply', '--check', '-R', `-p${(entry && entry.depth) || 1}`, file], {
      cwd: serverDir, stdio: 'pipe', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(serverDir)) },
    });
    return true;
  } catch { return false; }
}

/**
 * What a patch changes besides WordPress version header lines (`Version:` / `Stable tag:`): the count
 * of added/removed lines and the files they're in (a binary change counts its file, not its lines).
 * A bridge with none is a version bump only; one with some carries code that lifting the pin drops.
 */
function localEdits(patchText) {
  let lines = 0;
  const files = [];
  for (const chunk of patchText.split(/^(?=diff --git )/m)) {
    const hunks = chunk.includes('\n@@ ') ? chunk.slice(chunk.indexOf('\n@@ ')) : ''; // past the ---/+++ file header
    const n = hunks.split('\n').filter((l) => /^[-+]/.test(l) && !/^[-+][\s*#/]*(?:Version|Stable tag)\s*:/i.test(l)).length;
    if (!n && !/^(?:GIT binary patch|Binary files )/m.test(chunk)) continue;
    lines += n;
    const file = chunk.match(/^\+\+\+ (?!\/dev\/null$)(.+)$/m) || chunk.match(/^--- (.+)$/m) || chunk.match(/^diff --git \S+ (.+)$/m);
    if (file) files.push(file[1]);
  }
  return { lines, files };
}

// A bridge patch's description starts with this: the next version move drops it (see reconcile-run).
const BRIDGE = 'Bridges ';

/**
 * Remove the heal's own extra.patches entry for a package (patches/<slug>.patch) and its file, then
 * relock so it's no longer applied. Patches the heal did not write stay. Returns the removed entries.
 */
async function dropPatches(projectDir, pkg, runner, slug) {
  const composerPath = path.join(projectDir, 'composer.json');
  if (!fs.existsSync(composerPath)) return [];
  const text = fs.readFileSync(composerPath, 'utf8');
  const c = JSON.parse(text);
  if (!(c.extra && c.extra.patches && c.extra.patches[pkg])) return [];
  const all = patchEntries(c.extra.patches[pkg]);
  const removed = all.filter((e) => isHealEntry(e, slug));
  if (!removed.length) return [];
  // Its local patch file goes too: rewritten if a residual remains, orphaned otherwise.
  for (const e of removed) fs.rmSync(path.join(projectDir, urlOf(e)), { force: true });
  if (removed.length < all.length) c.extra.patches[pkg] = all.filter((e) => !isHealEntry(e, slug));
  else delete c.extra.patches[pkg];
  if (!Object.keys(c.extra.patches).length) delete c.extra.patches;
  fs.writeFileSync(composerPath, serializeComposer(c, text));
  await runner.composer(['patches-relock'], { cwd: projectDir });
  return removed;
}

module.exports = { reconcilePatched, dropPatches, BRIDGE };
