'use strict';
const fs = require('fs');
const path = require('path');
const { parseManifest } = require('./parse-drift');
const { parseContentDiff, modifiedPaths } = require('./parse-content-diff');
const { classify, versionConstraint } = require('./classify');
const { upsertRequire, removeRequire, isPinnedConstraint, ensureCweagansSetup, serializeComposer, REAPPLY } = require('./composer');
const { riskyPluginCategory } = require('./risky-plugins');
const { decideOutcome } = require('./outcome');
const { reconcilePatched, dropPatches, BRIDGE } = require('./reconcile-patched');
const { adoptComponent } = require('./adopt');
const { isSensitive } = require('./detectors');
const { generatePatch } = require('./patch-gen');
const { scanPath, assessDiff } = require('./suspicious');
const { pluginVersion, themeVersion } = require('./extract-version');

// Items healed by moving a composer require/lock (not by copying code).
const VERSION_CATEGORIES = new Set(['wpackagist-plugin', 'wpackagist-theme', 'satispress', 'removed']);

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
 * @param {string} [o.coreVersionRemote] server's WP core version (recorded by the core hook)
 * @param {boolean} [o.coreManagedByHost] core files aren't writable by the deploy user: the host owns core
 * @param {(p:string)=>boolean} [o.isTracked] true for a path git tracks in source (or a dir holding some)
 * @param {(items:{type:string,slug:string,version:string}[])=>Promise<{matches:object[]}[]|null>} [o.vulnCheck]
 *   known vulnerabilities per item (ServiceApp vulns/match); null/throw = unavailable
 * @param {Set<string>} [o.only] apply only these item keys; every other item is deferred (left for
 *   the next run's review PR) — how a mixed heal merges its no-review part first
 * @param {{since:string, packages:Set<string>, files:string[], core:boolean}} [o.pending] what commits not
 *   yet deployed (since the last build's source) changed: a drifted version they also changed is
 *   superseded (their version stands, the next Deploy ships it); drifted code they changed is held
 * @param {Set<string>} [o.supersededKeys] the heal on the deployed commit: items the undeployed commits
 *   supersede — one that needs a real patch (server edits, not just a version) is held for review,
 *   since the undeployed version would drop those edits
 * @returns {Promise<{classified:object[], outcome:string, applied:string[]}>}
 */
async function reconcileRun(o) {
  const items = parseManifest(o.manifestText);
  const mods = modifiedPaths(parseContentDiff(o.contentDiffText || ''));
  const classified = await classify(items, { resolvers: o.resolvers, treeRoot: o.treeRoot, modifiedPaths: mods, isTracked: o.isTracked,
    requires: (() => { try { return JSON.parse(fs.readFileSync(path.join(o.sourceDir, 'composer.json'), 'utf8')).require || {}; } catch { return {}; } })() });

  if (o.only) {
    for (const c of classified) {
      if (!o.only.has(c.key) && c.category !== 'ignorable') {
        c.category = 'deferred';
        c.recoverable = false;
        c.remediation = `${c.key}: left for review — the next run opens a PR for it.`;
      }
    }
  }

  // Undeployed commits changed these too. A version (or removal): the repo's pending version stands;
  // the heal built on the deployed commit records the server's, so the next Deploy ships the pending
  // one. Code (patches, committed or adopted files) can't be merged safely either way: review.
  const pendingHolds = new Map();
  if (o.pending) {
    const short = o.pending.since.slice(0, 7);
    const touched = (c) => (c.composerPackage && o.pending.packages.has(c.composerPackage))
      || o.pending.files.some((f) => (c.root && (f === c.root || f.startsWith(`${c.root}/`))) || (c.paths || []).includes(f) || f === c.key);
    for (const c of classified) {
      if (!c.recoverable || !touched(c)) continue;
      // patched-candidate too: the server's copy differing may be just another version; if the heal on
      // the deployed commit needs a real patch, o.supersededKeys holds it there (see the hold loop).
      if (VERSION_CATEGORIES.has(c.category) || (c.category === 'patched-candidate' && o.pending.packages.has(c.composerPackage))) {
        c.category = 'superseded';
        c.recoverable = false;
        c.remediation = `changed on the server, but commits not deployed yet (since ${short}) change it too. **No repo change:** the repo's version stands, and the next Deploy ships it.`;
      } else {
        pendingHolds.set(c.key, `${c.key}: also changed by commits not yet deployed (since ${short}) — review which version should win`);
      }
    }
  }

  const composerPath = path.join(o.sourceDir, 'composer.json');
  const hasComposer = fs.existsSync(composerPath);
  const originalComposerText = hasComposer ? fs.readFileSync(composerPath, 'utf8') : null;
  let composer = originalComposerText ? JSON.parse(originalComposerText) : null;
  const applied = [];

  // Class 4 — WordPress core. Only where the repo manages core (extra.wordpress-core is set): a host
  // that manages core itself is left alone (removing/re-adding that line is the fleet's commonest
  // churn). The version comes from the server, so accept only a version-shaped string.
  const remoteCore = String(o.coreVersionRemote || '').trim();
  const repoCore = composer && composer.extra && composer.extra['wordpress-core'];
  const coreChangedUndeployed = !!(o.pending && o.pending.core);
  if (repoCore && o.coreManagedByHost && !coreChangedUndeployed && (!o.only || o.only.has('wordpress-core'))) {
    // The host owns core (not writable by the deploy user): the repo can't enforce a version, so it
    // stops claiming one — maintenance then stops bumping it and deploys stop warning about it.
    delete composer.extra['wordpress-core'];
    if (!Object.keys(composer.extra).length) delete composer.extra;
    fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
    applied.push('core:host-managed-removed');
    classified.push({ key: 'wordpress-core', category: 'wp-core', recoverable: true, verified: true,
      remediation: `WordPress core is managed by the host (not writable by the deploy user); removed extra.wordpress-core (${repoCore}).` });
  } else if (!repoCore && composer && remoteCore && !o.coreManagedByHost && !coreChangedUndeployed && /^\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?$/.test(remoteCore)
      && (!o.only || o.only.has('wordpress-core'))) {
    // The line was dropped (2026-10-01: maintenance no longer re-adds it), but the deploy user can
    // write core here: bring it back at exactly the server's version — no update is triggered.
    composer.extra = { ...(composer.extra || {}), 'wordpress-core': remoteCore };
    fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
    applied.push(`core:managed-again:${remoteCore}`);
    classified.push({ key: 'wordpress-core', category: 'wp-core', recoverable: true, verified: true,
      remediation: `WordPress core is writable by the deploy user: composer manages it again, at the server's ${remoteCore}.` });
  } else if (repoCore && remoteCore && remoteCore !== repoCore && o.pending && o.pending.core && (!o.only || o.only.has('wordpress-core'))) {
    classified.push({ key: 'wordpress-core', category: 'superseded', recoverable: false,
      remediation: `WordPress core: the server has ${remoteCore}, but commits not yet deployed changed extra.wordpress-core; the repo's ${repoCore} stands.` });
  } else if (repoCore && remoteCore && remoteCore !== repoCore && (!o.only || o.only.has('wordpress-core'))) {
    if (/^\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?$/.test(remoteCore)) {
      composer.extra['wordpress-core'] = remoteCore;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
      applied.push(`core:${repoCore}->${remoteCore}`);
      classified.push({ key: 'wordpress-core', category: 'wp-core', recoverable: true, verified: true,
        remediation: `${remoteCore} on the server → \`extra.wordpress-core\` ${repoCore} → ${remoteCore}.` });
    } else {
      classified.push({ key: 'wordpress-core', category: 'wp-core', recoverable: false,
        remediation: `The server reported an unexpected WordPress core version (${remoteCore.slice(0, 40)}); not applied.` });
    }
  }

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

  // Versions locked before this run, to tell a downgrade (never auto-merged) from an update.
  const lockedBefore = {};
  try {
    for (const p of JSON.parse(fs.readFileSync(path.join(o.sourceDir, 'composer.lock'), 'utf8')).packages || []) {
      lockedBefore[p.name] = String(p.version).replace(/^v/, '');
    }
  } catch { /* no lock yet */ }

  // A bridge patch only fits the version it was cut against: drop it before any version move, or
  // composer would apply it to the new version and fail. Pass 2 cuts a new one if a gap remains.
  if (o.runner && composer && composer.extra && composer.extra.patches) {
    for (const c of classified) {
      if (!c.recoverable || !c.composerPackage) continue;
      const entries = [].concat(composer.extra.patches[c.composerPackage] || []);
      if (!entries.some((e) => e && String(e.description || '').startsWith(BRIDGE))) continue;
      await dropPatches(o.sourceDir, c.composerPackage, o.runner);
      applied.push(`bridge-dropped:${c.composerPackage}`);
    }
    composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
  }
  // Classify fell back from a server header composer can't parse (4.0.0-dev2) to the newest published
  // version: Pass 2 bridges the gap with a patch.
  for (const c of classified) if (c.recoverable && c.serverVersion && c.version && c.serverVersion !== c.version) c.bridge = true;

  // Pass 1 — reproduce the server's EXACT version without bumping constraints. Install the
  // server's version into the LOCK via a temporary constraint (`--with <pkg>:<ver>`), leaving
  // composer.json's range untouched (add only a `>=<server>` floor for a brand-new require). This
  // makes the build byte-reproduce the server (convergence) instead of jumping to the latest that
  // satisfies `>=` — the whole point of reconciling. A deliberately-pinned exact constraint is
  // never changed; it's flagged instead. Applied ONE package at a time so composer's resolver acts
  // as the availability check; an unsatisfiable target reverts + flags rather than faking success.
  // ponytail: sequential updates (n small).
  for (const c of classified) {
    if (!c.recoverable || !c.composerPackage || !composer) continue;
    if (c.category === 'removed') {
      // Its patches go with it, or a later reinstall at another version would get them applied.
      if (o.runner && (await dropPatches(o.sourceDir, c.composerPackage, o.runner)).length) {
        applied.push(`patches-dropped:${c.composerPackage}`);
        composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
      }
      composer = removeRequire(composer, c.composerPackage).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
      if (o.runner) {
        const rm = await o.runner.composer(['update', c.composerPackage, '--no-progress'], { cwd: o.sourceDir });
        if (rm.code !== 0) applied.push(`remove:${c.composerPackage}:lock-update-failed`);
      }
      applied.push(`remove:${c.composerPackage}`);
      continue;
    }
    const target = c.version; // exact version to lock (server's, or a composer-valid fallback)
    const had = !!(composer.require && Object.prototype.hasOwnProperty.call(composer.require, c.composerPackage));
    const existing = had ? composer.require[c.composerPackage] : undefined;
    c.newRequire = !had;
    if (lockedBefore[c.composerPackage] && target && compareVersions(target, lockedBefore[c.composerPackage]) < 0) {
      c.downgrade = lockedBefore[c.composerPackage];
    }

    // A pin already equal to the server version verifies clean. A pin the server moved past is
    // lifted below (the server already runs that version).
    const pinnedDiffers = had && isPinnedConstraint(existing) && !!target && existing.trim().replace(/^==\s*/, '') !== String(target);
    if (had && isPinnedConstraint(existing) && !pinnedDiffers) { applied.push(`require:${c.composerPackage}:pinned-ok`); continue; }

    // New require: add a `>=<server>` floor. Existing range: leave it unchanged (do NOT bump).
    if (!had) {
      composer = upsertRequire(composer, c.composerPackage, versionConstraint(target)).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
    }

    if (!o.runner) continue;

    // Install the exact server version into the lock, keeping composer.json's constraint. Partial
    // update first (keep siblings locked so a broken sibling can't fail this solve); escalate to -W
    // only if the plugin genuinely needs its own deps co-updated.
    const withArg = target ? ['--with', `${c.composerPackage}:${target}`] : [];
    const tryUpdate = async () => {
      const u = await o.runner.composer(['update', c.composerPackage, ...withArg, '--no-progress'], { cwd: o.sourceDir });
      return u.code === 0 ? u : o.runner.composer(['update', c.composerPackage, '-W', ...withArg, '--no-progress'], { cwd: o.sourceDir });
    };
    let upd = pinnedDiffers ? { code: 1, stdout: '', stderr: '' } : await tryUpdate();
    // The registry may just not have picked the release up yet: ask wpackagist to refresh it once, then retry.
    if (upd.code !== 0 && !pinnedDiffers && /^wpackagist-(plugin|theme)\//.test(c.composerPackage) && o.runner.refreshWpackagist
        && await o.runner.refreshWpackagist(c.composerPackage.split('/')[1])) {
      upd = await tryUpdate();
      if (upd.code === 0) applied.push(`refreshed:${c.composerPackage}`);
    }

    // The constraint itself rules the server's version out (a pin it moved past, or a floor above a
    // downgrade): relax it to `>=<server>` and retry. Restore it if even that cannot install.
    if (upd.code !== 0 && had && target && versionConstraint(target) !== existing) {
      const relaxed = versionConstraint(target);
      composer = upsertRequire(composer, c.composerPackage, relaxed).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
      upd = await tryUpdate();
      if (upd.code === 0) {
        c.constraintRelaxed = { from: existing, to: relaxed };
        c.remediation = `v${target} on the server → constraint \`${existing}\` → \`${relaxed}\`, locked at v${target}.`;
        applied.push(`require:${c.composerPackage}:relaxed`);
        continue;
      }
      composer = upsertRequire(composer, c.composerPackage, existing).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
    }
    if (upd.code !== 0 && target && c.root && o.treeRoot && fs.existsSync(path.join(o.treeRoot, c.root))) {
      // No registry has the server's version (an unreleased build): install the newest one below it.
      // Pass 2 bridges the rest with a patch; if it can't, this is undone after it.
      c.requireBefore = { had, existing, locked: lockedBefore[c.composerPackage] };
      composer = upsertRequire(composer, c.composerPackage, `<${target}`).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
      upd = await o.runner.composer(['update', c.composerPackage, '-W', '--no-progress'], { cwd: o.sourceDir });
      // A branch (dev-trunk, on minimum-stability: dev) is no base to pin and patch.
      const base = upd.code === 0 ? lockedVersion(o.sourceDir, c.composerPackage) : '';
      if (base && !/^dev-|-dev$/.test(base)) { c.bridge = true; applied.push(`require:${c.composerPackage}:bridge-base`); continue; }
      if (upd.code === 0) await o.runner.composer(['update', c.composerPackage, '-W', '--no-progress', ...(had ? ['--with', `${c.composerPackage}:${existing}`] : [])], { cwd: o.sourceDir });
      upd = { code: 1, stdout: upd.stdout, stderr: upd.stderr };
      composer = had ? upsertRequire(composer, c.composerPackage, existing).composer : removeRequire(composer, c.composerPackage).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText));
      delete c.requireBefore;
    }
    if (upd.code !== 0) {
      const out = (upd.stdout || '') + (upd.stderr || '');
      // A registry we cannot reach or authenticate to says nothing about the version: fail the run
      // like the baseline install guard does, rather than report it unavailable and open a PR.
      if (REGISTRY_ERROR.test(out)) {
        throw new Error(`composer could not reach or authenticate a repository while resolving ${c.composerPackage} — check SatisPress auth (COMPOSER_AUTH):\n${out.slice(-1600)}`);
      }
      // Unsatisfiable — drop a new-add require so composer.json stays installable (existing range
      // constraints were never touched, so there's nothing to revert for a bump).
      if (!had) { composer = removeRequire(composer, c.composerPackage).composer; fs.writeFileSync(composerPath, serializeComposer(composer, originalComposerText)); }
      c.recoverable = false;
      c.category = 'version-unavailable';
      c.composerOutput = ((upd.stdout || '') + (upd.stderr || '')).trim().slice(-1600);
      const reason = firstComposerError(c.composerOutput);
      // The server's own header (it may not be a version composer can parse, e.g. 4.0.0-dev2), not the pin tried.
      const onServer = c.serverVersion || target;
      c.remediation = `${onServer ? `v${onServer}` : 'a version'} on the server. **To match:** lock \`${c.composerPackage}\`${target ? ` at v${target}` : ''}. Not done here: composer can't install it${reason ? ` (${reason.replace(/\.+$/, '')})` : ''}. Once the registry offers it, a later check makes this change; to match sooner, commit the plugin's files to the repo.`;
      applied.push(`require:${c.composerPackage}:unavailable`);
      continue;
    }
    // Say what was actually done: the classify-time text predates the solve.
    if (target) {
      c.remediation = !had ? `installed on the server at v${target} → added to composer.json (\`${versionConstraint(target)}\`), locked at v${target}.`
        : lockedBefore[c.composerPackage] === String(target) ? `v${target} on the server → already locked at v${target}; nothing to change.`
        : `v${target} on the server → lock moved to v${target} (constraint \`${existing}\` unchanged).`;
    }
    applied.push(`require:${c.composerPackage}`);
  }

  // Pass 2 — patches, a separate pass: only for a modified-from-published component that Pass 1's
  // exact version did NOT converge. reconcilePatched reinstalls it pristine and diffs against the
  // server; the cweagans/composer-patches setup is bootstrapped (once, into the PR) only when the
  // first real residual appears, so a bump that converges never drags in the patch tooling.
  let patchSupport = null; // null = not needed yet; true/false once decided
  const ensurePatchSupport = async () => {
    if (patchSupport !== null) return patchSupport;
    if (!composer) { patchSupport = false; return false; }
    // Complete the setup (saucal/composer-patches + allow-plugins, old jq hook dropped) — also in
    // repos that already require cweagans with or without the old hook.
    const current = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
    const hadCweagans = !!(current.require && (current.require['cweagans/composer-patches'] || current.require[REAPPLY]));
    const b = ensureCweagansSetup(current);
    if (b.changed) {
      fs.writeFileSync(composerPath, serializeComposer(b.composer, originalComposerText));
      composer = b.composer;
      applied.push(hadCweagans ? 'patch-setup:completed' : 'bootstrap:cweagans');
      if (o.runner && !(current.require && current.require[REAPPLY])) {
        const upd = await o.runner.composer(['update', REAPPLY, '-W', '--no-progress'], { cwd: o.sourceDir });
        if (upd.code !== 0) applied.push('bootstrap:cweagans:update-failed');
      }
    }
    patchSupport = true;
    return true;
  };
  // Any composer-managed component Pass 1's version did not converge goes to the patch pass, not
  // only those the content diff flagged: whatever is left after the right version is a patch.
  for (const c of classified) {
    if (!c.recoverable || !c.composerPackage || !c.root || c.category === 'patched-candidate') continue;
    const src = path.join(o.sourceDir, c.root);
    const srv = path.join(o.treeRoot || '', c.root);
    if (!fs.existsSync(src) || !fs.existsSync(srv)) continue;
    try { if (generatePatch(src, srv, c.root).trim()) c.category = 'patched-candidate'; } catch { /* leave as is */ }
  }
  for (const c of classified) {
    if (c.category !== 'patched-candidate') continue;
    if (!composer) {
      c.category = 'patch-unsupported';
      c.recoverable = false;
      c.remediation = `${c.key} is modified from its published version, but this project has no composer.json to add cweagans/composer-patches to. Patch manually.`;
      applied.push(`patched:${c.key}:skipped-no-composer`);
      continue;
    }
    const root = c.root || `plugins/${c.key}`;
    const res = await reconcilePatched({
      projectDir: o.sourceDir,
      slug: c.key,
      pkg: c.composerPackage,
      serverDir: path.join(o.treeRoot, root),
      pluginRoot: root,
      runner: o.runner,
      ensurePatchSupport,
      allowVersionGap: !!c.bridge,
    });
    applied.push(`patched:${c.key}:${res.action}`);
    if (res.action === 'version-mismatch') {
      c.category = 'patch-version-mismatch';
      c.recoverable = false;
      c.remediation = `${c.key}: composer installs v${res.installed}, but the server's copy says v${res.server}. A patch only describes edits on top of one version — review manually.`;
      continue;
    }
    if (res.action === 'bump-only') {
      // The published release reproduces the server: a plain version move, not a patch.
      c.category = String(c.composerPackage).startsWith('wpackagist-') ? `wpackagist-${c.kind || 'plugin'}` : 'satispress';
      c.remediation = `v${c.version || '?'} on the server → lock moved to v${c.version || '?'} (the server's files match that release exactly).`;
      continue;
    }
    if (res.action === 'bridged') {
      // Pin the base exactly: a range would move to the next release, where the patch can't apply.
      const text = fs.readFileSync(composerPath, 'utf8');
      composer = upsertRequire(JSON.parse(text), c.composerPackage, res.installed).composer;
      fs.writeFileSync(composerPath, serializeComposer(composer, text));
      c.bridged = { from: res.installed, to: res.server };
      c.localEdits = res.localEdits;
    }
    if (!res.patchFile) continue;
    c.patchFile = res.patchFile;
    const edits = c.bridged && c.localEdits && c.localEdits.files.length ? `${c.localEdits.lines} lines in ${c.localEdits.files.join(', ')}` : '';
    c.remediation = c.bridged && edits
      ? `v${c.bridged.to} on the server, which no published release has → pinned at v${c.bridged.from} (the newest published) with local edits (${edits}) plus the version bump to v${c.bridged.to}, both in \`${res.patchFile.replace(/^\.\//, '')}\`. Lifting the pin drops those edits: carry them over before the server moves to a release.`
      : c.bridged
      ? `v${c.bridged.to} on the server, which no published release has → pinned at v${c.bridged.from} (the newest published), with \`${res.patchFile.replace(/^\.\//, '')}\` bridging the rest. When the server moves to a release, the next check lifts the pin and drops the patch.`
      : `v${c.version || '?'} with local edits on the server → locked at v${c.version || '?'}, edits kept in \`${res.patchFile.replace(/^\.\//, '')}\`.`;
    const patchText = fs.readFileSync(path.join(o.sourceDir, res.patchFile), 'utf8');
    c.delta = assessDiff(patchText);
    c.editsVersion = editsVersion(patchText);
    if (c.delta.critical.length) {
      await withdrawPatch(o, c);
      delete c.bridged; // a Pass 1 fallback is undone below
      c.category = 'suspicious';
      c.recoverable = false;
      c.remediation = `${c.key}: the server's edits carry signals of compromised code — patch withheld from the PR. Review the server as a possible incident.`;
      applied.push(`patched:${c.key}:held-suspicious`);
    }
  }

  // A Pass 1 fallback Pass 2 didn't bridge: put the require and the lock back as they were.
  for (const c of classified) {
    if (!c.requireBefore || c.bridged) continue;
    const { had, existing, locked } = c.requireBefore;
    const text = fs.readFileSync(composerPath, 'utf8');
    composer = (had ? upsertRequire : removeRequire)(JSON.parse(text), c.composerPackage, existing).composer;
    fs.writeFileSync(composerPath, serializeComposer(composer, text));
    await o.runner.composer(['update', c.composerPackage, ...(had && locked ? ['--with', `${c.composerPackage}:${locked}`] : []), '--no-progress'], { cwd: o.sourceDir });
    applied.push(`require:${c.composerPackage}:bridge-undone`);
  }

  // Pass 2b — code committed to the repo (custom plugins/themes, client-mu-plugins, acf-json):
  // the server's version is the fix. Assess the delta first; a compromised one is not copied.
  const trackedPaths = [];
  for (const c of classified) {
    if (c.category !== 'tracked') continue;
    const files = c.paths.map((p) => {
      const src = path.join(o.sourceDir, p);
      const srv = path.join(o.treeRoot || '', p);
      const st = o.treeRoot && fs.existsSync(srv) ? fs.lstatSync(srv) : null;
      return { p, src, srv, onServer: !!st && st.isFile(), symlink: !!st && st.isSymbolicLink(), inSource: fs.existsSync(src) };
    });
    const diff = files.filter((f) => f.inSource || f.onServer)
      .map((f) => generatePatch(f.inSource ? f.src : '/dev/null', f.onServer ? f.srv : '/dev/null', f.p)).join('\n');
    c.delta = assessDiff(diff);
    for (const f of files) if (f.symlink) c.delta.holds.push({ file: f.p, rule: 'symlink', line: 0 });
    if (c.delta.critical.length) {
      c.category = 'suspicious';
      c.recoverable = false;
      c.remediation = `${c.key}: the server's version carries signals of compromised code — not copied into the repo. Review the server as a possible incident.`;
      applied.push(`tracked:${c.key}:held-suspicious`);
      continue;
    }
    for (const f of files) {
      if (f.symlink) continue;
      if (f.onServer) { fs.mkdirSync(path.dirname(f.src), { recursive: true }); fs.copyFileSync(f.srv, f.src); }
      else if (f.inSource) fs.rmSync(f.src);
      trackedPaths.push(f.p);
    }
    c.verified = true;
    applied.push(`tracked:${c.key}`);
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

      // Never vendor server code that carries signals of compromise: hold it for a human.
      const hits = serverHits(c, o.treeRoot);
      if (hits.some((h) => h.severity === 'critical')) {
        c.category = 'suspicious';
        c.recoverable = false;
        c.security = hits;
        c.remediation = `${c.key} on the server carries signals of compromised code — not adopted. Review it as a possible security incident.`;
        applied.push(`adopt:${c.key}:held-suspicious`);
        continue;
      }

      try {
        const res = adoptComponent({ sourceDir: o.sourceDir, treeRoot: o.treeRoot, root, isSensitive });
        c.category = res.skipped > 0 ? 'adopted-lossy' : 'adopted';
        c.recoverable = true;
        c.adoptedRoot = root;
        const count = `${res.files} file${res.files === 1 ? '' : 's'}`;
        const named = (label, list) => (list.length ? ` ${label}: ${list.map((p) => `\`${p}\``).join(', ')}.` : '');
        c.remediation = (res.skipped > 0
          ? `Vendored ${c.key} into the repo (${count}); ${res.skipped} sensitive file(s) skipped — review whether they matter.`
          : `Vendored ${c.key} into the repo (${count}) — not available on wpackagist/SatisPress.`)
          + named('Symlinks, committed as links', res.symlinks) + named('Files of 1 MB or more', res.large);
        adoptedPaths.push(root);
        applied.push(`adopt:${c.key}`);
      } catch (e) {
        c.remediation = `Adoption failed for ${c.key}: ${e.message}`;
        applied.push(`adopt:${c.key}:failed`);
      }
    }
  }

  // Pass 3b — known vulnerabilities (ServiceApp's Wordfence/CVE feed) for whatever lands at a version
  // nobody picked upstream: additions, downgrades, adopted code. No answer is not a clean answer.
  const toCheck = classified.filter((c) => c.recoverable && (c.newRequire || c.downgrade || String(c.category).startsWith('adopted')));
  if (toCheck.length) {
    const items = toCheck.map((c) => {
      const hdr = c.root && o.treeRoot ? (c.kind === 'theme' ? themeVersion : pluginVersion)(path.join(o.treeRoot, c.root)) : null;
      return { type: c.kind === 'theme' ? 'theme' : 'plugin', slug: c.key, version: String(c.version || (hdr && hdr.version) || '') };
    });
    let results = null;
    if (o.vulnCheck) { try { results = await o.vulnCheck(items); } catch { results = null; } }
    toCheck.forEach((c, i) => {
      c.vulnVersion = items[i].version;
      c.vulns = results && results[i] && Array.isArray(results[i].matches) ? results[i].matches : null;
    });
  }

  // Pass 4 — verify convergence (where do we land?). The consistency check already reverse-synced
  // the LIVE server into treeRoot (built/), and every applied change is installed/vendored under
  // sourceDir. Byte-compare each recovered component's reconciled tree against the captured server
  // state: `verified` means a deploy from this PR reproduces the server for that component;
  // residual files mean the fix is incomplete (the site would still drift there). This reuses the
  // server state already captured — no second rsync/SSH or rebuild needed.
  let verified = 0;
  let verifiable = 0;
  for (const c of classified) {
    if (!c.recoverable || !c.root) continue;
    const srcDir = path.join(o.sourceDir, c.root);
    const srvDir = path.join(o.treeRoot, c.root);
    if (!fs.existsSync(srcDir) || !fs.existsSync(srvDir)) continue; // can't compare locally → leave unknown
    let residual;
    try { residual = generatePatch(srcDir, srvDir, c.root); } catch { continue; }
    verifiable++;
    c.verified = residual.trim() === '';
    if (c.verified) verified++;
    else c.residualFiles = (residual.match(/^diff --git/gm) || []).length;
  }
  const verification = { verified, verifiable, residual: verifiable - verified };

  // Pass 5 — security scan of everything this PR would take from the server WITHOUT a registry
  // behind it: patch residuals (added lines only), adopted/unknown/unverified components and loose
  // files. A version a registry reproduces byte-for-byte has provenance and is not scanned. Deferred
  // and superseded items take nothing from the server here: the run that opens their PR scans them.
  const security = { critical: [], warn: [] };
  for (const c of classified) {
    if (['ignorable', 'needs-redeploy', 'deferred', 'superseded'].includes(c.category)) continue;
    let hits = c.security;
    if (!hits && c.delta) hits = [...c.delta.critical.map((h) => ({ ...h, severity: 'critical' })), ...c.delta.holds.map((h) => ({ ...h, severity: 'warn' }))];
    else if (!hits && (String(c.category).startsWith('adopted') || !(c.recoverable && c.verified === true))) hits = serverHits(c, o.treeRoot);
    if (!hits || !hits.length) continue;
    c.security = hits;
    if (hits.some((h) => h.severity === 'critical') && c.recoverable) {
      c.recoverable = false;
      c.category = 'suspicious';
      c.remediation = `${c.key}: the change taken from the server carries signals of compromised code. Review it as a possible security incident before merging.`;
    }
    for (const h of hits) security[h.severity === 'critical' ? 'critical' : 'warn'].push({ key: c.key, ...h });
  }

  // Compute outcome last so the cweagans downgrade is reflected.
  const outcome = decideOutcome(classified.filter((c) => !['deferred', 'superseded'].includes(c.category)));
  // composer.lock carries a hash of composer.json (extra included): any edit here — extra.patches,
  // extra.wordpress-core, a new require — must end with a hash refresh, or the build's
  // `composer validate` rejects the lock. --lock touches no versions.
  if (o.runner && hasComposer && fs.readFileSync(composerPath, 'utf8') !== originalComposerText) {
    const relock = await o.runner.composer(['update', '--lock', '--no-install', '--no-progress'], { cwd: o.sourceDir });
    if (relock.code !== 0) applied.push('composer:lock-refresh-failed');
  }

  // Auto-merge only what needs no judgement: version moves, removals, core, clean additions and
  // downgrades, and patch / committed-code deltas assessDiff found nothing in. Everything else is
  // pending: verify and the post-merge check ignore its paths, and the next run opens its PR.
  const buildsDir = workspaceMatcher(o.sourceDir);
  const itemReasons = new Map();
  const hold = (c, r) => { if (!itemReasons.has(c.key)) itemReasons.set(c.key, []); itemReasons.get(c.key).push(r); };
  for (const c of classified) {
    if (!c.recoverable) continue;
    if (String(c.category).startsWith('adopted')) hold(c, `${c.key}: adopts server files`);
    const risky = c.newRequire && riskyPluginCategory(c.composerPackage);
    if (risky) hold(c, `${c.key}: new high-risk plugin (${risky}) — confirm the site should have it`);
    // The build runs the scripts of the packages the workspace lists, with all of Deploy's secrets:
    // a new plugin a workspace glob covers (e.g. plugins/*) would join that list unreviewed.
    if (c.newRequire && c.root && buildsDir(c.root) && shipsScripts(path.join(o.sourceDir, c.root))) {
      hold(c, `${c.key}: new plugin ships package.json scripts the build would run (a workspace pattern covers ${c.root})`);
    }
    if (c.newRequire || c.downgrade || String(c.category).startsWith('adopted')) {
      if (!c.vulns) hold(c, `${c.key}: vulnerability check unavailable`);
      else if (c.vulns.length) hold(c, `${c.key}: known vulnerabilit${c.vulns.length > 1 ? 'ies' : 'y'} at v${c.vulnVersion || '?'} — ${c.vulns.map((v) => v.cve || v.id).join(', ')}`);
    }
    if (c.delta && c.delta.holds.length) hold(c, `${c.key}: ${[...new Set(c.delta.holds.map((h) => h.rule))].join(', ')}`);
    if (pendingHolds.has(c.key)) hold(c, pendingHolds.get(c.key));
    // A patch that changes the version the site runs never merges unattended.
    if (c.bridged) {
      const e = c.localEdits;
      hold(c, e && e.files.length
        ? `${c.key}: bridges to v${c.bridged.to} and carries ${e.lines} lines of local edits in ${e.files.join(', ')} — review`
        : `${c.key}: bridges to v${c.bridged.to}, which no published release has — confirm the site should run it`);
    } else if (c.patchFile && c.editsVersion) hold(c, `${c.key}: its patch changes the plugin's version header — confirm the site should run it`);
    if (o.supersededKeys && o.supersededKeys.has(c.key) && c.patchFile) {
      hold(c, `${c.key}: the server's edits to it would be dropped by the version in commits not yet deployed — review`);
    }
  }
  const critical = security.critical.length > 0;
  const eligible = critical ? [] : classified.filter((c) => c.recoverable && !itemReasons.has(c.key)).map((c) => c.key);
  // Superseded on the tip: the deployed commit's heal failing on one leaves it pending, not held (the tip's version stands).
  const needsHuman = classified.filter((c) => !c.recoverable && !['ignorable', 'deferred', 'superseded'].includes(c.category)
    && !(o.supersededKeys && o.supersededKeys.has(c.key)));
  // A .php component root is a single-file plugin; a directory root is a slug and gets the trailing slash.
  const pathOf = (c) => (c.root ? (/\.php$/.test(c.root) ? `/${c.root}` : `/${c.root}/`) : (c.key === 'wordpress-core' ? null : `/${c.key}`));
  const pending = classified.filter((c) => !eligible.includes(c.key)).map(pathOf).filter(Boolean);
  // What this PR leaves on the server as it is (a hand-merged PR carries it all, held items included).
  const open = classified.filter((c) => !c.recoverable).map(pathOf).filter(Boolean);
  const reasons = [...itemReasons.values()].flat();
  if (needsHuman.length) reasons.push(`needs a human: ${needsHuman.map((c) => `${c.key} (${c.category})`).join(', ')}`);
  if (critical) reasons.unshift('signals of compromised code — nothing merges automatically');
  const autoMerge = { ok: !critical && eligible.length > 0 && !itemReasons.size && !needsHuman.length, reasons, eligible, pending: [...new Set(pending)], open: [...new Set(open)] };

  return { classified, outcome, applied, adoptedPaths, trackedPaths, verification, security, autoMerge };
}

/** True when a patch adds or removes a WordPress version header line (`Version:` / `Stable tag:`). */
function editsVersion(patchText) {
  return /^[-+](?![-+]{2} )[\s*#/]*(?:Version|Stable tag)\s*:/im.test(patchText);
}

/** The version composer.lock holds for a package ('' if none). */
function lockedVersion(dir, pkg) {
  try {
    const p = (JSON.parse(fs.readFileSync(path.join(dir, 'composer.lock'), 'utf8')).packages || []).find((x) => x.name === pkg);
    return p ? String(p.version).replace(/^v/, '') : '';
  } catch { return ''; }
}

/** Numeric comparison of version strings (1.10 > 1.9); suffixes are ignored. */
function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Take a just-written patch back out (compromised content never goes into the PR). */
async function withdrawPatch(o, c) {
  const composerPath = path.join(o.sourceDir, 'composer.json');
  const text = fs.readFileSync(composerPath, 'utf8');
  const cj = JSON.parse(text);
  if (cj.extra && cj.extra.patches) {
    delete cj.extra.patches[c.composerPackage];
    if (!Object.keys(cj.extra.patches).length) delete cj.extra.patches;
    fs.writeFileSync(composerPath, serializeComposer(cj, text));
  }
  fs.rmSync(path.join(o.sourceDir, c.patchFile), { force: true });
  if (o.runner) {
    await o.runner.composer(['patches-relock'], { cwd: o.sourceDir });
    await o.runner.composer(['reinstall', c.composerPackage, '--no-progress'], { cwd: o.sourceDir });
  }
}

/** Scan a component's (or loose file's) server copy; file paths come back repo-relative. */
function serverHits(c, treeRoot) {
  if (!treeRoot) return [];
  return scanPath(path.join(treeRoot, c.root || c.key), treeRoot);
}

/** Pull the most informative line out of composer's error output for a one-line reason. */
const REGISTRY_ERROR = /required authentication|HTTP 40[13]|Could not authenticate|curl error|failed to open stream/i;

function firstComposerError(out) {
  if (!out) return '';
  // GitHub-annotation encoded output (`::error ::…%0A…`) reads as one garbled line: decode it first.
  const text = out.replace(/::(error|warning|notice)[^:]*::/g, '').replace(/%0D/g, '').replace(/%0A/g, '\n').replace(/%25/g, '%');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /could not be found|requires|no matching package|minimum-stability|does not (?:match|allow)|conflict|Root composer\.json requires/i.test(l) || REGISTRY_ERROR.test(l));
  return (hit || lines[lines.length - 1] || '').replace(/^-\s+/, '').slice(0, 300);
}

/**
 * Which directories the build runs node scripts in besides the root: the packages pnpm-workspace.yaml
 * lists (action-build builds the root only without one) or package.json "workspaces" (npm -ws).
 * shortcut: a line-based read of pnpm-workspace.yaml's `packages:` list and plain globs (* and **);
 * negated patterns are ignored, which can only over-hold.
 */
function workspaceMatcher(dir) {
  const patterns = [];
  try {
    let inPackages = false;
    for (const line of fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8').split('\n')) {
      if (/^packages:/.test(line)) { inPackages = true; continue; }
      if (inPackages && /^\S/.test(line)) inPackages = false;
      const m = inPackages && /^\s*-\s*["']?([^"'#\s]+)["']?/.exec(line);
      if (m) patterns.push(m[1]);
    }
  } catch { /* no pnpm workspace */ }
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).workspaces;
    patterns.push(...[].concat(Array.isArray(ws) ? ws : (ws && ws.packages) || []));
  } catch { /* no npm workspaces */ }
  const res = patterns.filter((p) => !p.startsWith('!')).map((p) => new RegExp('^' + p.replace(/^\.\//, '').replace(/\/+$/, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$'));
  return (rel) => res.some((re) => re.test(rel));
}

/** True when any package.json under dir (node_modules aside) declares scripts. */
function shipsScripts(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && shipsScripts(path.join(dir, e.name))) return true;
    if (e.isFile() && e.name === 'package.json') {
      try { if (Object.keys(JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')).scripts || {}).length) return true; } catch { return true; } // unreadable: assume the worst
    }
  }
  return false;
}

module.exports = { reconcileRun, firstComposerError };
