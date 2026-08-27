'use strict';

/**
 * Parse the consistency-check reverse content-diff buffer into per-file entries.
 * @param {string} text
 * @returns {{path:string, status:string}[]}
 */
function parseContentDiff(text) {
  const items = [];
  for (const line of String(text).split('\n')) {
    const simple = line.match(/^diff --git --simple (\S+) (.+)$/);
    if (simple) { items.push({ path: simple[2].trim(), status: simple[1] }); continue; }
    const std = line.match(/^diff --git (\S+) (\S+)$/);
    if (std) { items.push({ path: std[1].replace(/^a\//, ''), status: 'M' }); continue; }
  }
  return items;
}

// consistency-diff.sh collapses two kinds of modified file to a bodiless one-liner
// because printing the body says nothing: 'WS' differs only in whitespace (a CRLF flip
// from an FTP edit, a reindent), 'LL' has every changed line over the print limit (a
// minified bundle rebuilt on one side). Both are content modifications exactly like 'M'
// — the file on the server differs from its published version — so they belong here.
// A/D/R are absent/renamed, not modified, and stay out.
const MODIFIED_STATUSES = new Set(['M', 'WS', 'LL']);

/**
 * @param {{path:string, status:string}[]} items
 * @returns {Set<string>} paths that are content-modified
 */
function modifiedPaths(items) {
  return new Set(items.filter((i) => MODIFIED_STATUSES.has(i.status)).map((i) => i.path));
}

module.exports = { parseContentDiff, modifiedPaths };
