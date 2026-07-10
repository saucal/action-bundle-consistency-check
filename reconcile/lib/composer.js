'use strict';

/**
 * Add or bump a package constraint in a parsed composer.json object.
 * Returns a new object (input is not mutated).
 * @param {object} composer parsed composer.json
 * @param {string} pkg
 * @param {string} constraint
 * @returns {{composer:object, changed:boolean}}
 */
function upsertRequire(composer, pkg, constraint) {
  const next = JSON.parse(JSON.stringify(composer || {}));
  next.require = next.require || {};
  const changed = next.require[pkg] !== constraint;
  next.require[pkg] = constraint;
  return { composer: next, changed };
}

const CWEAGANS = 'cweagans/composer-patches';
// From saucal's "Automatically patching a plugin" doc: cweagans 2.0 has a lock file but
// does not respect it on install, so this reinstall-on-hash-change hook is required.
const POST_INSTALL_HOOK = `HASH=$(jq -r '._hash' patches.lock.json 2>/dev/null); if [ -z "$HASH" ] || [ "$(cat .patches_applied 2>/dev/null)" != "$HASH" ]; then echo "Patches hash Changed!" && echo "$HASH" > .patches_applied && composer reinstall $(jq -r '.extra.patches | keys | .[]' composer.json); if [ $? -ne 0 ]; then rm .patches_applied; fi; fi`;

/**
 * Ensure a project has the cweagans/composer-patches setup so reconcile can generate and
 * apply patches. Adds the require, the allow-plugins entry, and the post-install-cmd
 * reinstall hook when missing. Returns a new object (input untouched).
 * ponytail: does NOT synthesize installer-paths — a plugin can only be a patch candidate if
 * it is already composer-installed, which means the repo already has installer-paths.
 * @param {object} composer
 * @returns {{composer:object, changed:boolean}}
 */
function ensureCweagansSetup(composer) {
  const next = JSON.parse(JSON.stringify(composer || {}));
  let changed = false;

  next.require = next.require || {};
  if (!next.require[CWEAGANS]) { next.require[CWEAGANS] = '>=2.0.0'; changed = true; }

  next.config = next.config || {};
  next.config['allow-plugins'] = next.config['allow-plugins'] || {};
  if (next.config['allow-plugins'][CWEAGANS] !== true) { next.config['allow-plugins'][CWEAGANS] = true; changed = true; }

  next.scripts = next.scripts || {};
  let hook = next.scripts['post-install-cmd'];
  if (typeof hook === 'string') hook = [hook];
  else if (!Array.isArray(hook)) hook = [];
  if (!hook.some((l) => typeof l === 'string' && l.includes('.patches_applied'))) {
    hook.push(POST_INSTALL_HOOK);
    changed = true;
  }
  next.scripts['post-install-cmd'] = hook;

  return { composer: next, changed };
}

/** Find a top-level `"key": {...}` or `"key": [...]` block, brace-balanced and string-aware. */
function extractKeyBlock(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*`));
  if (!m) return null;
  let i = m.index + m[0].length;
  const open = text[i];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return { start: m.index, end: i + 1, text: text.slice(m.index, i + 1) };
  }
  return null;
}

/**
 * Serialize composer.json. Splices the original `repositories` block back so composer's
 * integer-indexed repository keys (e.g. "0") are not reordered by JSON.stringify's
 * integer-key hoisting — keeping the reconciliation diff limited to real changes.
 * ponytail: only `repositories` is preserved — the one composer key that uses numeric indices.
 * @param {object} obj
 * @param {string} [originalText] the composer.json we read before editing (require untouched)
 * @returns {string}
 */
function serializeComposer(obj, originalText) {
  let out = JSON.stringify(obj, null, 4) + '\n';
  if (originalText) {
    const orig = extractKeyBlock(originalText, 'repositories');
    const cur = extractKeyBlock(out, 'repositories');
    if (orig && cur) out = out.slice(0, cur.start) + orig.text + out.slice(cur.end);
  }
  return out;
}

module.exports = { upsertRequire, ensureCweagansSetup, serializeComposer };
