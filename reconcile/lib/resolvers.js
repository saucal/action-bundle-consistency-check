'use strict';

/**
 * @param {object} o
 * @param {typeof fetch} [o.fetch] injectable fetch for the public wpackagist lookup (defaults to global)
 * @param {object} [o.runner]     makeRunner()-shaped { composer(args,{cwd}) }, used for satispress.
 *   Required to resolve satispress at all — no runner means satispress() always returns null.
 * @param {string} [o.cwd]        composer project dir (has composer.json + the satispress repo
 *   entry + auth.json, already configured upstream by action-composer-auth in this job)
 */
function makeResolvers(o = {}) {
  const f = o.fetch || fetch;
  const { runner, cwd = '.' } = o;

  async function wpackagist(kind, slug) {
    const url = `https://api.wordpress.org/${kind}s/info/1.0/${slug}.json`;
    try {
      const r = await f(url);
      if (!r.ok) return null;
      const j = await r.json();
      if (!j || j.error || !j.version) return null;
      return { source: `wpackagist-${kind}`, package: `wpackagist-${kind}/${slug}`, version: j.version };
    } catch {
      return null;
    }
  }

  // Resolves through composer itself (`composer show`) rather than a hand-rolled HTTP call —
  // reuses the SAME auth.json action-composer-auth already configured in this job, so there is
  // exactly one place SatisPress credentials are ever handled. (A prior direct-fetch + guessed
  // Basic-auth implementation silently 401'd on every real lookup; see git history.)
  async function satispress(slug) {
    if (!runner) return null;
    const pkg = `saucal/${slug}`;
    const r = await runner.composer(['show', pkg, '--all', '--format=json'], { cwd });
    if (r.code !== 0) return null;
    let data;
    try { data = JSON.parse(r.stdout || '{}'); } catch { return null; }
    const versions = Array.isArray(data.versions) ? data.versions : [];
    // Skip dev/branch-alias entries (e.g. "3.x-dev") for a concrete version to pin.
    const stable = versions.find((v) => typeof v === 'string' && !/-dev$|^dev-/i.test(v));
    if (!stable) return null;
    return { source: 'satispress', package: pkg, version: stable };
  }

  return { wpackagist, satispress };
}

module.exports = { makeResolvers };
