'use strict';

/**
 * @param {typeof fetch} f       injectable fetch (defaults to global)
 * @param {string} satispressUrl base URL of the SatisPress composer repo ('' disables it)
 * @param {string} satispressToken optional HTTP Basic auth token (license key)
 * @param {string} [satispressPassword] HTTP Basic auth password. Must match the convention
 *   composer itself uses (action-composer-auth / build-for-deployment.sh): the project's
 *   composer.json `homepage`, protocol stripped — NOT empty. A mismatch here silently 401s
 *   every SatisPress lookup, misclassifying an available package as unresolvable
 *   ("premium-flag") instead of a normal add.
 */
function makeResolvers(f = fetch, satispressUrl = '', satispressToken = '', satispressPassword = '') {
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

  async function satispress(slug) {
    if (!satispressUrl) return null;
    const base = satispressUrl.replace(/\/$/, '');
    const url = `${base}/p2/saucal/${slug}.json`;
    // SatisPress requires HTTP Basic auth: username = token, password = project homepage
    // (matches composer's own auth.json, configured by action-composer-auth).
    const opts = satispressToken
      ? { headers: { Authorization: `Basic ${Buffer.from(`${satispressToken}:${satispressPassword}`).toString('base64')}` } }
      : undefined;
    try {
      const r = await f(url, opts);
      if (!r.ok) return null;
      const j = await r.json();
      const versions = j && j.packages && j.packages[`saucal/${slug}`];
      if (!Array.isArray(versions) || versions.length === 0) return null;
      return { source: 'satispress', package: `saucal/${slug}`, version: versions[0].version };
    } catch {
      return null;
    }
  }

  return { wpackagist, satispress };
}

module.exports = { makeResolvers };
