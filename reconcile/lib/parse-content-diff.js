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

/**
 * 'WS' is consistency-diff.sh's collapsed form for a file that differs only in
 * whitespace (a CRLF flip, a reindent). The body is omitted because it is noise, but
 * the file is still modified relative to its published version, so it counts as M.
 * @param {{path:string, status:string}[]} items
 * @returns {Set<string>} paths that are content-modified
 */
function modifiedPaths(items) {
  return new Set(items.filter((i) => i.status === 'M' || i.status === 'WS').map((i) => i.path));
}

module.exports = { parseContentDiff, modifiedPaths };
