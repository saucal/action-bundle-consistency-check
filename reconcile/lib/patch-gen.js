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
  // whitespace, so names with spaces keep their full path.
  const bases = [pristineDir, serverDir].flatMap((b) => [b.replace(/^\/+/, '/'), b.replace(/^\/+/, '')]);
  const rerootLine = (line) => bases.reduce((l, b) => l.split(`${b}/`).join(`${pluginRelRoot}/`), line);
  return raw.split('\n').map((line) => (/^(diff --git |--- |\+\+\+ )/.test(line) ? rerootLine(line) : line)).join('\n');
}

/**
 * Add or replace an extra.patches entry for a package. Returns a new object (input untouched).
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
  next.extra.patches[pkg] = [entry];
  const changed = before !== JSON.stringify([entry]);
  return { composer: next, changed };
}

module.exports = { generatePatch, upsertExtraPatches };
