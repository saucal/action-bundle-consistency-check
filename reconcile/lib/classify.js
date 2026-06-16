'use strict';
const path = require('path');
const { isCompiledAsset, isSensitive, isIgnorable, isVendorPath, componentOf } = require('./detectors');
const { pluginVersion, themeVersion } = require('./extract-version');

const WP_CORE_RE = /(?:^|\/)(?:wp-admin|wp-includes)\//;

function versionConstraint(v) { return v ? `>=${v}` : '*'; }

/**
 * @param {import('./parse-drift').DriftItem[]} items
 * @param {{resolvers:{wpackagist:Function,satispress:Function}, treeRoot:string}} ctx
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
  for (const it of loose) out.push(looseVerdict(it));
  for (const comp of components.values()) out.push(await componentVerdict(comp, ctx));
  return out;
}

function looseVerdict(it) {
  const p = it.path;
  if (WP_CORE_RE.test(p)) {
    return { key: p, category: 'wp-core', recoverable: true,
      remediation: `WordPress core file changed on server (${p}). Bump the core version via prepare-composer.` };
  }
  if (it.side === 'build-only') {
    return { key: p, category: 'needs-redeploy', recoverable: false,
      remediation: `In build but missing/changed on server (${p}). Redeploy required; not a source change.` };
  }
  if (isSensitive(p)) {
    return { key: p, category: 'sensitive', recoverable: false,
      remediation: `Sensitive file added on server (${p}). Review manually; never auto-commit.` };
  }
  if (isIgnorable(p)) {
    return { key: p, category: 'ignorable', recoverable: false,
      remediation: `Runtime/junk file (${p}). Add to SSH_IGNORE_LIST / SSH_IGNORE_LIST_EXTRA.` };
  }
  if (isCompiledAsset(p)) {
    return { key: p, category: 'compiled-asset', recoverable: false,
      remediation: `Compiled asset changed on server with no source mapping (${p}). Unrecoverable.` };
  }
  return { key: p, category: 'unknown', recoverable: false,
    remediation: `Unclassified drift (${p}). Review manually.` };
}

async function componentVerdict(comp, ctx) {
  const { resolvers, treeRoot, modifiedPaths = new Set() } = ctx;
  const label = `${comp.kind} ${comp.slug}`;

  if (comp.paths.some((it) => isSensitive(it.path))) {
    return { key: comp.slug, category: 'sensitive', recoverable: false,
      remediation: `Sensitive file inside ${label}. Review manually.` };
  }
  if (comp.paths.every((it) => isIgnorable(it.path))) {
    return { key: comp.slug, category: 'ignorable', recoverable: false,
      remediation: `All drift in ${label} is runtime/junk. Add to SSH_IGNORE_LIST.` };
  }

  const dir = path.join(treeRoot, comp.root);
  const hdr = comp.kind === 'theme' ? themeVersion(dir) : pluginVersion(dir);
  const treeVersion = hdr && hdr.version;

  const res = (await resolvers.wpackagist(comp.kind, comp.slug)) || (await resolvers.satispress(comp.slug));
  if (res) {
    const pin = treeVersion || res.version;
    const isModified = comp.paths.some((it) => modifiedPaths.has(it.path));
    if (isModified) {
      return { key: comp.slug, category: 'patched-candidate', recoverable: true,
        composerPackage: res.package, version: pin, root: comp.root, kind: comp.kind,
        remediation: `${label} is modified from its published version. Bump-first to v${pin}, then patch the residual (resolved at apply time).` };
    }
    return { key: comp.slug, category: res.source, recoverable: true,
      composerPackage: res.package, version: pin, root: comp.root, kind: comp.kind,
      remediation: `Add/bump \`${res.package}:${versionConstraint(pin)}\` in composer.json (server has ${label}${treeVersion ? ` v${treeVersion}` : ''}).` };
  }

  if (comp.paths.every((it) => isCompiledAsset(it.path) || isVendorPath(it.path))) {
    return { key: comp.slug, category: 'compiled-asset', recoverable: false,
      remediation: `${label} differs only in compiled/vendor files and is not resolvable to a package. Unrecoverable.` };
  }

  return { key: comp.slug, category: 'premium-flag', recoverable: false,
    remediation: `Premium/unknown ${label}${treeVersion ? ` v${treeVersion}` : ''} on server, not on wpackagist or SatisPress. Add to SatisPress or vendor manually.` };
}

module.exports = { classify, versionConstraint };
