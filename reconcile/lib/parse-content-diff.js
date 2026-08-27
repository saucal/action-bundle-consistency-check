'use strict';

// consistency-diff.sh runs `git diff -R`, so its headers read `diff --git b/<path>
// a/<path>` — the b/ side first. Strip either prefix: matching only a/ left every
// content-modified path as `b/wp-content/...`, which equals no component path, so
// isModified was permanently false and patched-candidate never fired.
const stripPrefix = (p) => p.replace(/^[ab]\//, '');

/**
 * Parse the consistency-check reverse content-diff buffer into per-file entries.
 * @param {string} text
 * @returns {{path:string, status:string}[]}
 */
function parseContentDiff(text) {
  const items = [];
  for (const line of String(text).split('\n')) {
    // `diff --git --simple LL b/x a/x` is a real diff whose long lines were truncated
    // for readability. The tag warns a human the body is not applicable as a patch; the
    // file is modified like any other, so it parses as M. Two paths follow the tag,
    // which is what separates it from the bodiless one-liners below.
    const tagged = line.match(/^diff --git --simple \S+ (\S+) (\S+)$/);
    if (tagged) { items.push({ path: stripPrefix(tagged[1]), status: 'M' }); continue; }
    const simple = line.match(/^diff --git --simple (\S+) (.+)$/);
    if (simple) { items.push({ path: simple[2].trim(), status: simple[1] }); continue; }
    const std = line.match(/^diff --git (\S+) (\S+)$/);
    if (std) { items.push({ path: stripPrefix(std[1]), status: 'M' }); continue; }
  }
  return items;
}

// 'WS' is consistency-diff.sh's bodiless form for a file that differs only in whitespace
// (a CRLF flip from an FTP edit, a reindent). Printing the body would say nothing, but
// the file on the server does differ from its published version, so it is a content
// modification exactly like 'M'. A/D/R are absent/renamed, not modified, and stay out.
const MODIFIED_STATUSES = new Set(['M', 'WS']);

/**
 * @param {{path:string, status:string}[]} items
 * @returns {Set<string>} paths that are content-modified
 */
function modifiedPaths(items) {
  return new Set(items.filter((i) => MODIFIED_STATUSES.has(i.status)).map((i) => i.path));
}

module.exports = { parseContentDiff, modifiedPaths };
