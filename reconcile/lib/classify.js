'use strict';
const fs = require('fs');
const path = require('path');
const { isCompiledAsset, isSensitive, isIgnorable, isVendorPath, componentOf } = require('./detectors');
const { pluginVersion, themeVersion } = require('./extract-version');

const WP_CORE_RE = /(?:^|\/)(?:wp-admin|wp-includes)\//;

function versionConstraint(v) { return v ? `>=${v}` : '*'; }

// A WordPress plugin header version isn't always a legal composer version (e.g. "4.0.0-dev2":
// `dev2` is not a valid stability suffix, so `>=4.0.0-dev2` makes composer.json unparseable).
// Only pin to versions composer can actually parse; otherwise fall back / leave unpinned.
function isComposerVersion(v) {
  return typeof v === 'string' &&
    /^v?\d+(\.\d+){0,3}(?:[.-]?(?:alpha|beta|rc|a|b|p|patch|pl|stable)\.?\d*)?$/i.test(v.trim());
}

/**
 * @param {import('./parse-drift').DriftItem[]} items
 * @param {{resolvers:{wpackagist:Function,satispress:Function}, treeRoot:string, isTracked?:(p:string)=>boolean}} ctx
 *   isTracked: true for a file git tracks in source, or a directory holding tracked files
 *   requires: composer.json's require map (to find the package behind a removed plugin)
 * @returns {Promise<Classified[]>}
 */
async function classify(items, ctx) {
  const components = new Map();   // slug -> {kind, slug, root, paths:[]}
  const loose = [];

  for (const it of items) {
    const c = componentOf(it.path);
    if (c && c.kind !== 'mu-plugin') {
      if (!components.has(c.slug)) components.set(c.slug, { ...c, paths: [] });
      components.get(c.slug).paths.push(it);
    } else {
      loose.push(it);
    }
  }

  const out = [];
  const isTracked = ctx.isTracked || (() => false);
  const onServer = (p) => !!ctx.treeRoot && fs.existsSync(path.join(ctx.treeRoot, p));
  for (const it of loose) out.push({ ...looseVerdict(it, isTracked, onServer), onServer: onServer(it.path) });
  for (const comp of components.values()) out.push(...[].concat(await componentVerdict(comp, ctx, isTracked)));
  return out;
}

function looseVerdict(it, isTracked, onServer = () => true) {
  const p = it.path;
  if (WP_CORE_RE.test(p)) {
    return { key: p, category: 'wp-core', recoverable: true,
      remediation: `WordPress core file changed on server (${p}). Bump the core version via prepare-composer.` };
  }
  if (isSensitive(p)) {
    return { key: p, category: 'sensitive', recoverable: false,
      remediation: `Sensitive file added on server (${p}). Review manually; never auto-commit.` };
  }
  if (isIgnorable(p)) {
    return { key: p, category: 'ignorable', recoverable: false,
      remediation: `Runtime/junk file (${p}). Add to SSH_IGNORE_LIST / SSH_IGNORE_LIST_EXTRA.` };
  }
  // Code the repo commits (client-mu-plugins, acf-json, ...): the server's version is the fix.
  const dir = path.posix.dirname(p);
  if (isTracked(p) || (dir !== '.' && isTracked(dir))) return trackedVerdict(p, null, [it], onServer);
  if (it.side === 'build-only') {
    return { key: p, category: 'needs-redeploy', recoverable: false,
      remediation: `In build but missing/changed on server (${p}). Redeploy required; not a source change.` };
  }
  if (isCompiledAsset(p)) {
    return { key: p, category: 'compiled-asset', recoverable: false,
      remediation: `Compiled asset changed on server with no source mapping (${p}). Unrecoverable.` };
  }
  return { key: p, category: 'unknown', recoverable: false,
    remediation: `Unclassified drift (${p}). Review manually.` };
}

/** Committed code: copy the server's version of these paths (deletions included) into source. */
function trackedVerdict(key, comp, items, onServer) {
  // remote-only = only on the server; build-only = missing on the server, or different there.
  const how = (it) => (it.side === 'remote-only' ? 'added' : onServer(it.path) ? 'changed' : 'deleted');
  const n = { added: 0, changed: 0, deleted: 0 };
  for (const it of items) n[how(it)]++;
  const remediation = items.length === 1
    ? { added: 'added on the server → added to the repo.', changed: 'changed on the server → the repo takes the server\'s version.', deleted: 'deleted on the server → deleted from the repo.' }[how(items[0])]
    : `${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} file(s) ${k}`).join(', ')} on the server → the repo takes the server's version of each.`;
  return { key, category: 'tracked', recoverable: true, paths: items.map((it) => it.path),
    ...(comp ? { root: comp.root, kind: comp.kind } : {}), remediation };
}

async function componentVerdict(comp, ctx, isTracked) {
  const { resolvers, treeRoot, modifiedPaths = new Set() } = ctx;
  const label = `${comp.kind} ${comp.slug}`;

  if (comp.paths.every((it) => isIgnorable(it.path))) {
    return { key: comp.slug, category: 'ignorable', recoverable: false,
      remediation: `All drift in ${label} is runtime/junk. Add to SSH_IGNORE_LIST.` };
  }

  // Committed to the repo: never look it up in a registry (a public slug collision would pull a
  // stranger's package). Sensitive files are never copied; they are flagged on their own.
  if (isTracked(comp.root)) {
    const keep = comp.paths.filter((it) => !isIgnorable(it.path) && !isSensitive(it.path));
    const flagged = comp.paths.filter((it) => isSensitive(it.path)).map((it) => ({ key: it.path, category: 'sensitive', recoverable: false,
      remediation: `Sensitive file in committed ${label} changed on server (${it.path}). Review manually; never auto-commit.` }));
    return keep.length ? [trackedVerdict(comp.slug, comp, keep, (p) => !!treeRoot && fs.existsSync(path.join(treeRoot, p))), ...flagged] : flagged;
  }

  const dir = path.join(treeRoot, comp.root);

  // Gone from the server (only build-side paths, no server copy at all): remove the require that
  // installs it. Resolving it instead would "bump" a deleted plugin to the latest release.
  if (treeRoot && !fs.existsSync(dir) && comp.paths.every((it) => it.side === 'build-only')) {
    const pkg = Object.keys(ctx.requires || {}).find((n) => n.split('/')[1] === comp.slug);
    if (pkg) {
      return { key: comp.slug, category: 'removed', recoverable: true, composerPackage: pkg, root: comp.root, kind: comp.kind,
        remediation: `removed from the server → \`${pkg}\` removed from composer.json.` };
    }
    return { key: comp.slug, category: 'needs-redeploy', recoverable: false,
      remediation: `in the build, not on the server, and no composer require installs it. **To match:** remove it from the repo.` };
  }

  const hdr = comp.kind === 'theme' ? themeVersion(dir) : pluginVersion(dir);
  const treeVersion = hdr && hdr.version;

  const res = (await resolvers.wpackagist(comp.kind, comp.slug)) || (await resolvers.satispress(comp.slug));
  if (res) {
    // Prefer the server's header version, but only if composer can parse it; else the resolver's
    // (published) version; else leave unpinned (`*`) rather than emit a constraint composer rejects.
    const pin = isComposerVersion(treeVersion) ? treeVersion
      : (isComposerVersion(res.version) ? res.version : null);
    const isModified = comp.paths.some((it) => modifiedPaths.has(it.path));
    if (isModified) {
      return { key: comp.slug, category: 'patched-candidate', recoverable: true,
        composerPackage: res.package, version: pin, root: comp.root, kind: comp.kind,
        remediation: `${label} is modified from its published version. Bump-first to ${pin ? `v${pin}` : 'its published version'}, then patch the residual (resolved at apply time).` };
    }
    return { key: comp.slug, category: res.source, recoverable: true,
      composerPackage: res.package, version: pin, root: comp.root, kind: comp.kind,
      remediation: `Add/bump \`${res.package}:${versionConstraint(pin)}\` in composer.json (server has ${label}${treeVersion ? ` v${treeVersion}` : ''}).` };
  }

  // Not resolvable to a package: only now consider flags. A sensitive-looking file bundled
  // inside a resolvable plugin must NOT block the add above — composer installs pristine.
  // Exclude vendor/ paths from the sensitive check: bundled SDKs (AWS, Google Cloud, ...) ship
  // dozens of legitimately-named `*Credentials.php` classes (credential-HANDLING code, not a
  // secret file) which would otherwise false-positive every cloud-storage plugin as "sensitive"
  // and permanently block it from adoption. A real secrets file directly in the component
  // (not vendor/) still flags.
  if (comp.paths.some((it) => isSensitive(it.path) && !isVendorPath(it.path))) {
    return { key: comp.slug, category: 'sensitive', recoverable: false,
      remediation: `Sensitive file inside ${label}, which is not resolvable to a package. Review manually.` };
  }

  if (comp.paths.every((it) => isCompiledAsset(it.path) || isVendorPath(it.path))) {
    return { key: comp.slug, category: 'compiled-asset', recoverable: false,
      remediation: `${label} differs only in compiled/vendor files and is not resolvable to a package. Unrecoverable.` };
  }

  return { key: comp.slug, category: 'premium-flag', recoverable: false,
    root: comp.root, kind: comp.kind,
    remediation: `${treeVersion ? `v${treeVersion}` : 'on the server'}${treeVersion ? ' on the server' : ''}, not on wpackagist or SatisPress. **To match:** add it to SatisPress, or commit its files to the repo.` };
}

module.exports = { classify, versionConstraint, isComposerVersion };
