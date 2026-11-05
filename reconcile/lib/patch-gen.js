'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Produce a unified diff transforming pristineDir -> serverDir, with paths rooted at
 * pluginRelRoot (e.g. "plugins/<slug>") so the patch applies with cweagans depth: 2.
 * Returns '' when the directories are identical, or differ only in file modes.
 * @param {string} pristineDir
 * @param {string} serverDir
 * @param {string} pluginRelRoot
 * @returns {string}
 */
function generatePatch(pristineDir, serverDir, pluginRelRoot) {
  let raw;
  try {
    // quotePath=false: non-ASCII names stay readable (quoted names would hide their real extension).
    raw = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-prefix', '--binary', '--no-renames', '--', pristineDir, serverDir], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    // git diff --no-index exits 1 when differences exist; its diff is on stdout. Anything else
    // (ENOBUFS included, which also carries a partial stdout) would be a truncated patch.
    if (e.status !== 1 || e.code) throw e;
    raw = e.stdout ? e.stdout.toString() : '';
  }
  // File modes are not drift (FTP clients and hosts flip them freely, and a mode-only patch is
  // useless to cweagans): drop mode lines, then any file left with no content change at all.
  raw = raw.split(/^(?=diff --git )/m)
    .map((chunk) => chunk.replace(/^(?:old|new) mode \d+\n/gm, ''))
    .filter((chunk) => !/^diff --git /.test(chunk) || /^(?:@@ |Binary files |GIT binary patch|new file mode|deleted file mode|similarity index)/m.test(chunk))
    .join('');
  if (!raw.trim()) return '';

  const reroot = (p) => {
    for (const base of [pristineDir, serverDir]) {
      // git diff --no-prefix may strip the leading slash; normalise both sides.
      const normP = p.startsWith('/') ? p : '/' + p;
      const normBase = base.startsWith('/') ? base : '/' + base;
      if (normP === normBase) return pluginRelRoot;
      if (normP.startsWith(normBase + path.sep)) {
        const sub = normP.slice(normBase.length + 1);
        return sub ? `${pluginRelRoot}/${sub}` : pluginRelRoot;
      }
    }
    return p; // leaves /dev/null and anything unexpected untouched
  };

  // Header lines: swap the two temp roots for the component root by prefix, not by splitting on
  // whitespace, so names with spaces keep their full path. A single-file root matches exactly.
  const bases = [pristineDir, serverDir].filter((b) => b !== '/dev/null')
    .flatMap((b) => [b.replace(/^\/+/, '/'), b.replace(/^\/+/, '')]);
  const esc = (b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rerootLine = (line) => bases.reduce((l, b) => l.replace(new RegExp(`${esc(b)}(?=/|\\s|$)`, 'g'), pluginRelRoot), line);
  return raw.split('\n').map((line) => (/^(diff --git |--- |\+\+\+ )/.test(line) ? rerootLine(line) : line)).join('\n');
}

/**
 * A package's extra.patches value as a list of entries; cweagans also takes a {description: url} map.
 * @returns {Array<{description?:string,url:string,depth?:number}|string>}
 */
function patchEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.entries(value).map(([description, url]) => ({ description, url }));
  return [value];
}

/** True when an extra.patches entry is the heal's own patch for slug (the file reconcilePatched writes). */
// shortcut: a developer patch literally named patches/<slug>.patch is taken for the heal's own; rename it to keep it.
function isHealEntry(entry, slug) {
  const url = typeof entry === 'string' ? entry : entry && entry.url;
  return !!url && String(url).replace(/^\.\//, '') === `patches/${slug}.patch`;
}

/**
 * Add or replace the heal's extra.patches entry for a package, after every patch it did not write
 * (a developer's patches are never replaced). Returns a new object (input untouched).
 * @param {object} composer parsed composer.json
 * @param {string} pkg
 * @param {{description:string,url:string,depth:number}} entry
 * @returns {{composer:object, changed:boolean}}
 */
function upsertExtraPatches(composer, pkg, entry) {
  const next = JSON.parse(JSON.stringify(composer || {}));
  next.extra = next.extra || {};
  next.extra.patches = next.extra.patches || {};
  const before = JSON.stringify(next.extra.patches[pkg] || null);
  const url = String(entry.url).replace(/^\.\//, '');
  const kept = patchEntries(next.extra.patches[pkg]).filter((e) => String(typeof e === 'string' ? e : e && e.url).replace(/^\.\//, '') !== url);
  next.extra.patches[pkg] = [...kept, entry];
  const changed = before !== JSON.stringify(next.extra.patches[pkg]);
  return { composer: next, changed };
}

module.exports = { generatePatch, upsertExtraPatches, patchEntries, isHealEntry };
