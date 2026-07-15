'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRunner } = require('../../lib/runner');

/**
 * Scaffold a temp composer project (path-repo fake plugins/themes) and run a REAL
 * `composer install`.
 *
 * @param {object} o
 * @param {Array<{slug:string,pkg:string,version:string,body?:string}>} [o.plugins]
 *   Each entry creates a path-repo dir <tmp>/pkgs/<slug>-<version>/. The same pkg
 *   may appear multiple times with different versions to allow version-bump tests;
 *   the `require` constraint uses the FIRST occurrence's version for that pkg.
 * @param {Array<{slug:string,pkg:string,version:string,body?:string}>} [o.themes]
 *   Same shape as plugins, but produces type:wordpress-theme path repos with a
 *   style.css header (routed to themes/{$name}/ via installer-paths).
 * @param {Array<{pkg:string,slug:string,root:string,patchText:string}>} [o.patches]
 *   Pre-existing applied patches. Each writes patches/<slug>.patch, registers an
 *   extra.patches entry, and (after install) runs patches-relock + patches-repatch
 *   so the BUILT state already carries the applied patch.
 * @returns {{dir:string, runner:object}}
 */
function makeProject(o) {
  const plugins = o.plugins || [];
  const themes = o.themes || [];
  const prePatches = o.patches || [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-proj-'));
  const pkgsRoot = path.join(dir, 'pkgs');
  fs.mkdirSync(pkgsRoot, { recursive: true });

  const repositories = [];
  const require = {
    'composer/installers': '^2.0',
    'cweagans/composer-patches': '^2.0',
  };
  const seenPkg = new Set();
  const baseline = {}; // pkg -> first-occurrence version, locked exactly in the built state

  function addPathRepo(p, isTheme) {
    const pkgDir = path.join(pkgsRoot, `${p.slug}-${p.version}`);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'composer.json'),
      JSON.stringify(
        {
          name: p.pkg,
          type: isTheme ? 'wordpress-theme' : 'wordpress-plugin',
          version: p.version,
        },
        null,
        4
      ) + '\n'
    );

    if (isTheme) {
      const style =
        '/*\n' +
        `Theme Name: ${p.slug}\n` +
        `Version: ${p.version}\n` +
        '*/\n';
      fs.writeFileSync(path.join(pkgDir, 'style.css'), style + (p.body || ''));
    } else {
      const header =
        '<?php\n' +
        '/**\n' +
        ` * Plugin Name: ${p.slug}\n` +
        ` * Version: ${p.version}\n` +
        ' */\n';
      fs.writeFileSync(
        path.join(pkgDir, `${p.slug}.php`),
        header + (p.body || '')
      );
    }

    repositories.push({
      type: 'path',
      url: `./pkgs/${p.slug}-${p.version}`,
      options: { symlink: false },
      // Non-canonical so multiple path repos for the same package (different
      // versions) can coexist without higher-priority repo masking lower ones.
      canonical: false,
    });

    // First occurrence of a pkg sets the root require constraint. Default to a `>=` RANGE (as real
    // Saucal projects do) with the exact version locked separately below; `pin: true` uses an exact
    // constraint instead (to exercise the "don't touch a deliberate pin" path).
    if (!seenPkg.has(p.pkg)) {
      require[p.pkg] = p.pin ? p.version : `>=${p.version}`;
      baseline[p.pkg] = p.version;
      seenPkg.add(p.pkg);
    }
  }

  for (const p of plugins) addPathRepo(p, false);
  for (const t of themes) addPathRepo(t, true);

  const composer = {
    name: 'saucal/test-project',
    description: 'Integration test fixture',
    require,
    repositories,
    extra: {
      'installer-paths': {
        'plugins/{$name}/': ['type:wordpress-plugin'],
        'themes/{$name}/': ['type:wordpress-theme'],
      },
    },
    config: {
      'allow-plugins': {
        'composer/installers': true,
        'cweagans/composer-patches': true,
      },
    },
    'minimum-stability': 'dev',
    'prefer-stable': true,
  };

  // Pre-existing patches: write patch files + register extra.patches BEFORE install
  // so the very first install applies them.
  if (prePatches.length) {
    const patchesDir = path.join(dir, 'patches');
    fs.mkdirSync(patchesDir, { recursive: true });
    composer.extra.patches = composer.extra.patches || {};
    for (const pp of prePatches) {
      fs.writeFileSync(
        path.join(patchesDir, `${pp.slug}.patch`),
        pp.patchText
      );
      composer.extra.patches[pp.pkg] = [
        {
          description: `Pre-existing patch for ${pp.slug}`,
          url: `./patches/${pp.slug}.patch`,
          depth: 2,
        },
      ];
    }
  }

  // Simulate a project that installs plugins via composer but has no patching setup.
  if (o.noCweagans) {
    delete composer.require['cweagans/composer-patches'];
    delete composer.config['allow-plugins']['cweagans/composer-patches'];
  }

  fs.writeFileSync(
    path.join(dir, 'composer.json'),
    JSON.stringify(composer, null, 4) + '\n'
  );

  // Lock each package at its baseline (first-occurrence) version while keeping the (possibly
  // ranged) constraint — mirrors real projects: `>=X` in composer.json, exact X in composer.lock,
  // newer versions available in the repos. Uses `composer update --with` (the same mechanism the
  // reconcile uses) so a `>=` constraint doesn't silently grab the latest at build time.
  const withArgs = Object.entries(baseline).flatMap(([pkg, v]) => ['--with', `${pkg}:${v}`]);
  execFileSync('composer', ['update', '--no-interaction', '--no-progress', ...withArgs], {
    cwd: dir,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });

  // Ensure pre-existing patches are locked + applied in the BUILT state.
  if (prePatches.length) {
    execFileSync('composer', ['patches-relock', '--no-interaction'], {
      cwd: dir,
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync('composer', ['patches-repatch', '--no-interaction'], {
      cwd: dir,
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  return { dir, runner: makeRunner() };
}

module.exports = { makeProject };
