'use strict';

/**
 * @param {typeof fetch} f       injectable fetch (defaults to global)
 * @param {string} satispressUrl base URL of the SatisPress composer repo ('' disables it)
 * @param {string} satispressToken optional HTTP Basic auth token (license key)
 */
function makeResolvers(f = fetch, satispressUrl = '', satispressToken = '') {
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
    // SatisPress requires HTTP Basic auth. Exact user:pass must be confirmed before
    // production (the build action uses `composer config http-basic.<host> <SATIS_KEY> ...`);
    // here we send base64(token:) as a best effort and degrade to null (flag) on failure.
    const opts = satispressToken
      ? { headers: { Authorization: `Basic ${Buffer.from(`${satispressToken}:`).toString('base64')}` } }
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
