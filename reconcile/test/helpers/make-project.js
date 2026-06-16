'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeRunner } = require('../../lib/runner');

/**
 * Scaffold a temp composer project (path-repo fake plugins) and run a REAL
 * `composer install`.
 *
 * @param {object} o
 * @param {Array<{slug:string,pkg:string,version:string,body?:string}>} o.plugins
 *   Each entry creates a path-repo dir <tmp>/pkgs/<slug>-<version>/. The same pkg
 *   may appear multiple times with different versions to allow version-bump tests;
 *   the `require` constraint uses the FIRST occurrence's version for that pkg.
 * @returns {{dir:string, runner:object}}
 */
function makeProject(o) {
  const plugins = o.plugins || [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-proj-'));
  const pkgsRoot = path.join(dir, 'pkgs');
  fs.mkdirSync(pkgsRoot, { recursive: true });

  const repositories = [];
  const require = {
    'composer/installers': '^2.0',
    'cweagans/composer-patches': '^2.0',
  };
  const seenPkg = new Set();

  for (const p of plugins) {
    const pkgDir = path.join(pkgsRoot, `${p.slug}-${p.version}`);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'composer.json'),
      JSON.stringify(
        { name: p.pkg, type: 'wordpress-plugin', version: p.version },
        null,
        4
      ) + '\n'
    );
    const header =
      '<?php\n' +
      '/**\n' +
      ` * Plugin Name: ${p.slug}\n` +
      ` * Version: ${p.version}\n` +
      ' */\n';
    fs.writeFileSync(path.join(pkgDir, `${p.slug}.php`), header + (p.body || ''));

    repositories.push({
      type: 'path',
      url: `./pkgs/${p.slug}-${p.version}`,
      options: { symlink: false },
      // Non-canonical so multiple path repos for the same package (different
      // versions) can coexist without higher-priority repo masking lower ones.
      canonical: false,
    });

    // First occurrence of a pkg pins the root require constraint.
    if (!seenPkg.has(p.pkg)) {
      require[p.pkg] = p.version;
      seenPkg.add(p.pkg);
    }
  }

  const composer = {
    name: 'saucal/test-project',
    description: 'Integration test fixture',
    require,
    repositories,
    extra: {
      'installer-paths': {
        'plugins/{$name}/': ['type:wordpress-plugin'],
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

  fs.writeFileSync(
    path.join(dir, 'composer.json'),
    JSON.stringify(composer, null, 4) + '\n'
  );

  execFileSync('composer', ['install', '--no-interaction', '--no-progress'], {
    cwd: dir,
    stdio: 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  });

  return { dir, runner: makeRunner() };
}

module.exports = { makeProject };
