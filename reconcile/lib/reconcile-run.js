'use strict';
const fs = require('fs');
const path = require('path');
const { parseManifest } = require('./parse-drift');
const { parseContentDiff, modifiedPaths } = require('./parse-content-diff');
const { classify, versionConstraint } = require('./classify');
const { upsertRequire, removeRequire, ensureCweagansSetup, serializeComposer } = require('./composer');
const { decideOutcome } = require('./outcome');
const { reconcilePatched } = require('./reconcile-patched');
const { adoptComponent } = require('./adopt');
const { isSensitive } = require('./detectors');

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
  let bootstrapCweagans = false;
  const applied = [];

  // Baseline install: probe the composer environment (PHP, composer binary, SatisPress auth)
  // and materialise vendor/lock so per-package updates are incremental. If this fails, composer
  // cannot verify anything here — surface the real cause (env/auth) instead of misreporting
  // every add as "version-unavailable". Once it passes, a per-package update failure genuinely
  // means that version is unsatisfiable.
  const needsComposer = classified.some((c) => c.recoverable && c.composerPackage);
  if (o.runner && hasComposer && needsComposer) {
    const inst = await o.runner.composer(['install', '--no-progress'], { cwd: o.sourceDir });
    if (inst.code !== 0) {
      throw new Error(
        'composer install failed in the reconcile environment — check PHP/composer setup and ' +
        'SatisPress auth (COMPOSER_AUTH). Composer output:\n' + ((inst.stdout || '') + (inst.stderr || ''))
      );
    }
  }

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
        bootstrapCweagans = true;
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

  // Persist the cweagans bootstrap (and install it) before touching plugin requires.
  if (composerChanged) fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
  if (bootstrapCweagans && o.runner) {
    const upd = await o.runner.composer(['update', 'cweagans/composer-patches', '-W', '--no-progress'], { cwd: o.sourceDir });
    if (upd.code !== 0) applied.push('bootstrap:cweagans:update-failed');
  }

  // Pass 1 — require add/bump (also pins patched-candidate to its target version), applied ONE
  // package at a time so composer's resolver acts as the availability check. The version is
  // derived from the server's plugin header; if no published package satisfies `>=<version>`
  // (e.g. the server runs a dev/unreleased build), composer update fails — we then REVERT the
  // constraint (never commit an uninstallable composer.json) and flag it as a decision rather
  // than reporting a false "Applied". Without this, merging the PR would not bring the site
  // back in sync. ponytail: sequential updates (n small); batch if a repo ever adds dozens.
  for (const c of classified) {
    if (!c.recoverable || !c.composerPackage || !composer) continue;
    const constraint = versionConstraint(c.version);
    const had = !!(composer.require && Object.prototype.hasOwnProperty.call(composer.require, c.composerPackage));
    const prev = had ? composer.require[c.composerPackage] : undefined;

    const r = upsertRequire(composer, c.composerPackage, constraint);
    composer = r.composer;
    fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));

    if (!o.runner) { if (r.changed) composerChanged = true; continue; }

    // Partial update first: keep every other package at its locked version so a pre-existing
    // unsatisfiable sibling (e.g. a delisted plugin already in the repo) can't fail THIS plugin's
    // solve. Escalate to -W only if the plugin genuinely needs its own dependencies co-updated.
    let upd = await o.runner.composer(['update', c.composerPackage, '--no-progress'], { cwd: o.sourceDir });
    if (upd.code !== 0) {
      upd = await o.runner.composer(['update', c.composerPackage, '-W', '--no-progress'], { cwd: o.sourceDir });
    }
    if (upd.code !== 0) {
      // Unsatisfiable — restore the prior constraint (or drop the add) so composer.json stays installable.
      composer = (had ? upsertRequire(composer, c.composerPackage, prev) : removeRequire(composer, c.composerPackage)).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
      c.recoverable = false;
      c.category = 'version-unavailable';
      // Surface composer's own reason so the log/PR say WHY (missing version vs. stability vs. a
      // broken global solve), instead of an opaque "unavailable".
      c.composerOutput = ((upd.stdout || '') + (upd.stderr || '')).trim().slice(-1600);
      const reason = firstComposerError(c.composerOutput);
      c.remediation = `Server has ${c.key}${c.version ? ` v${c.version}` : ''}, but composer could not install \`${c.composerPackage}:${constraint}\`${reason ? ` — ${reason}` : ''}. Merging would not bring the site in sync; resolve and re-run.`;
      applied.push(`require:${c.composerPackage}:unavailable`);
      continue;
    }
    if (r.changed) composerChanged = true;
    applied.push(`require:${c.composerPackage}`);
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

  // Pass 3 — adoption (opt-in via o.adopt). A component on neither wpackagist nor SatisPress can't
  // be recovered through composer; as a last resort, vendor its server files into the repo so a
  // deploy reproduces them. Auth-gated: only after the authenticated composer authoritatively
  // confirms the package is unavailable (guards against a resolver false-negative), and sensitive
  // files are never copied.
  const adoptedPaths = [];
  if (o.adopt) {
    for (const c of classified) {
      if (c.category !== 'premium-flag') continue;
      const root = c.root || `plugins/${c.key}`;

      // Authoritative re-check: if composer (authenticated) can see any candidate package, this is
      // NOT an adoption case — it should be a composer add. Skip so we never fork a resolvable plugin.
      if (o.runner) {
        const names = [`wpackagist-plugin/${c.key}`, `wpackagist-theme/${c.key}`, `saucal/${c.key}`];
        let resolvable = false;
        for (const n of names) {
          const s = await o.runner.composer(['show', n, '--all', '--no-interaction'], { cwd: o.sourceDir });
          if (s.code === 0) { resolvable = true; break; }
        }
        if (resolvable) {
          c.remediation = `${c.key} resolves via composer after all — re-run to add it via composer instead of vendoring.`;
          applied.push(`adopt:${c.key}:skipped-resolvable`);
          continue;
        }
      }

      try {
        const res = adoptComponent({ sourceDir: o.sourceDir, treeRoot: o.treeRoot, root, isSensitive });
        c.category = res.skipped > 0 ? 'adopted-lossy' : 'adopted';
        c.recoverable = true;
        c.adoptedRoot = root;
        c.remediation = res.skipped > 0
          ? `Vendored ${c.key} into the repo (${res.files} files); ${res.skipped} sensitive file(s) skipped — review whether they matter.`
          : `Vendored ${c.key} into the repo (${res.files} files) — not available on wpackagist/SatisPress.`;
        adoptedPaths.push(root);
        applied.push(`adopt:${c.key}`);
      } catch (e) {
        c.remediation = `Adoption failed for ${c.key}: ${e.message}`;
        applied.push(`adopt:${c.key}:failed`);
      }
    }
  }

  // Compute outcome last so the cweagans downgrade is reflected.
  const outcome = decideOutcome(classified);
  return { classified, outcome, applied, adoptedPaths };
}

/** Pull the most informative line out of composer's error output for a one-line reason. */
function firstComposerError(out) {
  if (!out) return '';
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /could not be found|requires|no matching package|minimum-stability|does not (?:match|allow)|conflict|Root composer\.json requires/i.test(l));
  return (hit || lines[lines.length - 1] || '').slice(0, 300);
}

module.exports = { reconcileRun };
