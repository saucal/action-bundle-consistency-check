'use strict';

const COMPILED_RE = /(?:\.min\.(?:js|css)$|\/(?:build|dist)\/|\.map$)/i;
const SENSITIVE_RE = /(?:credential|secret|(?:^|\/)\.env(?:\.|$)|wp-config)/i;
const IGNORABLE_RE = /(?:\.log(?:\.[\w.]+)?$|\.tick$|debug.*\.json$|purge-[\w-]*\.json$)/i;
const VENDOR_RE = /\/vendor\//;
const COMPONENT_RE = /(?:^|\/)(plugins|themes|mu-plugins)\/([^/]+)/;

function isCompiledAsset(p) { return COMPILED_RE.test(p); }
function isSensitive(p) { return SENSITIVE_RE.test(p); }
function isIgnorable(p) { return IGNORABLE_RE.test(p); }
function isVendorPath(p) { return VENDOR_RE.test(p); }

/**
 * Map a repo-relative path to its component root + slug.
 * @returns {{kind:'plugin'|'theme'|'mu-plugin', slug:string, root:string}|null}
 */
function componentOf(p) {
  const m = COMPONENT_RE.exec(p);
  if (!m) return null;
  const kind = m[1] === 'themes' ? 'theme' : (m[1] === 'plugins' ? 'plugin' : 'mu-plugin');
  const end = m.index + m[0].length;
  return { kind, slug: m[2], root: p.slice(0, end).replace(/^\//, '') };
}

module.exports = { isCompiledAsset, isSensitive, isIgnorable, isVendorPath, componentOf };
