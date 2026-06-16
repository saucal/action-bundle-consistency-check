'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Produce a unified diff transforming pristineDir -> serverDir, with paths rooted at
 * pluginRelRoot (e.g. "plugins/<slug>") so the patch applies with cweagans depth: 2.
 * Returns '' when the directories are identical.
 * @param {string} pristineDir
 * @param {string} serverDir
 * @param {string} pluginRelRoot
 * @returns {string}
 */
function generatePatch(pristineDir, serverDir, pluginRelRoot) {
  let raw;
  try {
    raw = execFileSync('git', ['diff', '--no-index', '--no-prefix', '--', pristineDir, serverDir], { encoding: 'utf8' });
  } catch (e) {
    // git diff --no-index exits 1 when differences exist; its diff is on stdout.
    raw = e.stdout ? e.stdout.toString() : '';
    if (!raw) throw e;
  }
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

  return raw.split('\n').map((line) => {
    let m = line.match(/^diff --git (\S+) (\S+)$/);
    if (m) return `diff --git ${reroot(m[1])} ${reroot(m[2])}`;
    m = line.match(/^(---|\+\+\+) (\S+)(.*)$/);
    if (m) return `${m[1]} ${reroot(m[2])}${m[3]}`;
    return line;
  }).join('\n');
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
