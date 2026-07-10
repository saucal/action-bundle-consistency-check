'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Copy a project's installed component roots (plugins/, themes/) plus its top-level
 * files into a fresh temp serverDir, then apply scenario-specific mutations.
 *
 * The copy mirrors what a "server" filesystem looks like: the deployed plugins/themes
 * and any root files, WITHOUT composer metadata. mutate(serverDir) applies the drift.
 *
 * @param {string} projectDir composer project root (post-install)
 * @param {(serverDir:string)=>void} [mutate]
 * @param {string[]} [roots]
 * @returns {string} serverDir
 */
function stageServer(projectDir, mutate, roots = ['plugins', 'themes']) {
  const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-'));

  // Copy component roots recursively.
  for (const root of roots) {
    const src = path.join(projectDir, root);
    if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
      copyDir(src, path.join(serverDir, root));
    }
  }

  // Copy top-level files (not the skipped metadata, not directories).
  for (const name of fs.readdirSync(projectDir)) {
    if (shouldSkip(name)) continue;
    const src = path.join(projectDir, name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(serverDir, name));
    }
  }

  if (mutate) mutate(serverDir);
  return serverDir;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// Skip composer metadata, vendor, patches, git, pkgs (path-repo sources).
function shouldSkip(name) {
  if (name === '.git') return true;
  if (name === 'vendor') return true;
  if (name === 'pkgs') return true;
  if (name.startsWith('patches')) return true;
  if (name.startsWith('composer.')) return true;
  return false;
}

/**
 * Walk builtDir (the project root) vs serverDir to derive an rsync-style drift
 * manifest + a reverse content diff, exactly the inputs reconcileRun expects.
 *
 *   - on server but not built   -> manifest `deleting <rel>`
 *   - in built but not server   -> manifest `<rel>`
 *   - in both, bytes differ     -> manifest `<rel>` + a content-diff block (status M),
 *                                  rerooted so the header is `diff --git <rel> <rel>`.
 *
 * @param {string} builtDir  project root (rel paths become plugins/<slug>/...)
 * @param {string} serverDir staged server tree
 * @param {string[]} [roots]
 * @returns {{manifestText:string, contentDiffText:string}}
 */
function deriveDrift(builtDir, serverDir, roots = ['plugins', 'themes']) {
  const builtFiles = new Map(); // rel -> abs
  const serverFiles = new Map();

  // Recurse component roots.
  for (const root of roots) {
    collect(path.join(builtDir, root), root, builtFiles);
    collect(path.join(serverDir, root), root, serverFiles);
  }
  // Top-level files on each side.
  collectTop(builtDir, builtFiles);
  collectTop(serverDir, serverFiles);

  const manifest = [];
  const diffBlocks = [];

  const allRels = new Set([...builtFiles.keys(), ...serverFiles.keys()]);
  for (const rel of [...allRels].sort()) {
    const b = builtFiles.get(rel);
    const s = serverFiles.get(rel);
    if (s && !b) {
      // server-only -> a build->server sync would delete it.
      manifest.push(`deleting ${rel}`);
    } else if (b && !s) {
      manifest.push(rel);
    } else {
      // both present: compare bytes.
      const bBuf = fs.readFileSync(b);
      const sBuf = fs.readFileSync(s);
      if (!bBuf.equals(sBuf)) {
        manifest.push(rel);
        diffBlocks.push(diffBlock(b, s, rel));
      }
    }
  }

  return {
    manifestText: manifest.join('\n') + (manifest.length ? '\n' : ''),
    contentDiffText: diffBlocks.join('\n') + (diffBlocks.length ? '\n' : ''),
  };
}

function collect(dir, relPrefix, map) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    if (entry.isDirectory()) collect(abs, rel, map);
    else if (entry.isFile()) map.set(rel, abs);
  }
}

function collectTop(dir, map) {
  for (const name of fs.readdirSync(dir)) {
    if (shouldSkip(name)) continue;
    if (name === 'plugins' || name === 'themes' || name === 'mu-plugins') continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isFile()) map.set(name, abs);
  }
}

/**
 * Produce a single `git diff --no-index` block for one modified file, with both temp
 * paths rerooted to `rel`, so parse-content-diff sees `diff --git <rel> <rel>` (status M).
 */
function diffBlock(builtFile, serverFile, rel) {
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['diff', '--no-index', '--no-prefix', '--', builtFile, serverFile],
      { encoding: 'utf8' }
    );
  } catch (e) {
    raw = e.stdout ? e.stdout.toString() : '';
    if (!raw) throw e;
  }

  const reroot = (p) => {
    const norm = (x) => (x.startsWith('/') ? x : '/' + x);
    for (const base of [builtFile, serverFile]) {
      if (norm(p) === norm(base)) return rel;
    }
    return p; // /dev/null and the like
  };

  return raw
    .split('\n')
    .map((line) => {
      let m = line.match(/^diff --git (\S+) (\S+)$/);
      if (m) return `diff --git ${reroot(m[1])} ${reroot(m[2])}`;
      m = line.match(/^(---|\+\+\+) (\S+)(.*)$/);
      if (m) return `${m[1]} ${reroot(m[2])}${m[3]}`;
      return line;
    })
    .join('\n')
    .replace(/\n+$/, '');
}

module.exports = { stageServer, deriveDrift };
