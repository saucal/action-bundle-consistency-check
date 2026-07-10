'use strict';
const fs = require('fs');
const path = require('path');
const { parseManifest } = require('./parse-drift');
const { parseContentDiff, modifiedPaths } = require('./parse-content-diff');
const { classify, versionConstraint } = require('./classify');
const { upsertRequire, ensureCweagansSetup, serializeComposer } = require('./composer');
const { decideOutcome } = require('./outcome');
const { reconcilePatched } = require('./reconcile-patched');

/**
 * Orchestrator core (no git/gh). Classifies drift and applies recoverable changes to the
 * composer project at sourceDir, using the server-state tree at treeRoot.
 * @param {object} o
 * @param {string} o.sourceDir       composer project root (has composer.json + installed plugins)
 * @param {string} o.treeRoot        server-state tree (drifted files; e.g. reverse-synced built dir)
 * @param {string} o.manifestText    rsync drift manifest
 * @param {string} [o.contentDiffText] reverse content diff (for modified-from-published detection)
 * @param {object} o.resolvers       { wpackagist, satispress }
 * @param {object} o.runner          makeRunner()-shaped { composer(args,{cwd}) }
 * @returns {Promise<{classified:object[], outcome:string, applied:string[]}>}
 */
async function reconcileRun(o) {
  const items = parseManifest(o.manifestText);
  const mods = modifiedPaths(parseContentDiff(o.contentDiffText || ''));
  const classified = await classify(items, { resolvers: o.resolvers, treeRoot: o.treeRoot, modifiedPaths: mods });

  const composerPath = path.join(o.sourceDir, 'composer.json');
  const hasComposer = fs.existsSync(composerPath);
  const originalComposerText = hasComposer ? fs.readFileSync(composerPath, 'utf8') : null;
  let composer = originalComposerText ? JSON.parse(originalComposerText) : null;
  let composerChanged = false;
  const applied = [];
  const toUpdate = new Set();

  // Patch reconciliation needs cweagans/composer-patches. If a modified-from-published plugin
  // is present but the project lacks it, BOOTSTRAP the setup into the PR (per saucal's
  // "Automatically patching a plugin" doc) so patch recovery works everywhere. Only when there
  // is no composer.json at all do we flag instead (nothing to add it to).
  const patchedCandidates = classified.filter((c) => c.category === 'patched-candidate');
  const hasCweagans = !!(composer && composer.require && composer.require['cweagans/composer-patches']);
  if (patchedCandidates.length && !hasCweagans) {
    if (composer) {
      const b = ensureCweagansSetup(composer);
      composer = b.composer;
      if (b.changed) {
        composerChanged = true;
        toUpdate.add('cweagans/composer-patches');
        applied.push('bootstrap:cweagans');
      }
    } else {
      for (const c of patchedCandidates) {
        c.category = 'patch-unsupported';
        c.recoverable = false;
        c.remediation = `${c.key} is modified from its published version, but this project has no composer.json to add cweagans/composer-patches to. Patch manually.`;
        applied.push(`patched:${c.key}:skipped-no-composer`);
      }
    }
  }

  // Pass 1 — require add/bump (also pins patched-candidate to its target version).
  for (const c of classified) {
    if (!c.recoverable || !c.composerPackage || !composer) continue;
    const r = upsertRequire(composer, c.composerPackage, versionConstraint(c.version));
    composer = r.composer;
    if (r.changed) composerChanged = true;
    toUpdate.add(c.composerPackage);
  }
  if (composerChanged) fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));

  // Resolve the new constraints so installed plugins reflect them.
  if (toUpdate.size && o.runner) {
    await o.runner.composer(['update', ...toUpdate, '-W', '--no-progress'], { cwd: o.sourceDir });
    for (const p of toUpdate) applied.push(`require:${p}`);
  }

  // Pass 2 — patches for modified-from-published (after the package is at its target version).
  for (const c of classified) {
    if (c.category !== 'patched-candidate') continue;
    const root = c.root || `plugins/${c.key}`;
    const res = await reconcilePatched({
      projectDir: o.sourceDir,
      slug: c.key,
      pkg: c.composerPackage,
      serverDir: path.join(o.treeRoot, root),
      pluginRoot: root,
      runner: o.runner,
    });
    applied.push(`patched:${c.key}:${res.action}`);
  }

  // Compute outcome last so the cweagans downgrade is reflected.
  const outcome = decideOutcome(classified);
  return { classified, outcome, applied };
}

module.exports = { reconcileRun };
