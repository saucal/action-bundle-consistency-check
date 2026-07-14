'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Vendor a component's server files into the source repo — the last-resort recovery for a
 * plugin/theme available on neither wpackagist nor SatisPress. Copies treeRoot/<root> ->
 * sourceDir/<root>, skipping any file whose repo-relative path is sensitive (never vendor
 * credentials). The whole server dir is copied, not just drifted files, so the deploy
 * reproduces the plugin in full.
 *
 * @param {object} o
 * @param {string} o.sourceDir   composer project root
 * @param {string} o.treeRoot    server-state tree
 * @param {string} o.root        repo-relative component root (e.g. plugins/<slug>)
 * @param {(relPath:string)=>boolean} [o.isSensitive]  predicate on repo-relative paths to skip
 * @returns {{files:number, skipped:number, root:string}}
 */
function adoptComponent(o) {
  const from = path.join(o.treeRoot, o.root);
  if (!fs.existsSync(from)) throw new Error(`adopt: server dir not found: ${from}`);
  const to = path.join(o.sourceDir, o.root);
  fs.rmSync(to, { recursive: true, force: true });

  let files = 0;
  let skipped = 0;
  const walk = (relDir) => {
    const srcDir = path.join(o.treeRoot, o.root, relDir);
    for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const rel = path.join(o.root, relDir, e.name); // repo-relative path
      const s = path.join(srcDir, e.name);
      if (e.isDirectory()) { walk(path.join(relDir, e.name)); continue; }
      if (o.isSensitive && o.isSensitive(rel)) { skipped++; continue; }
      const d = path.join(o.sourceDir, rel);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
      else fs.copyFileSync(s, d);
      files++;
    }
  };
  walk('');
  return { files, skipped, root: o.root };
}

module.exports = { adoptComponent };
