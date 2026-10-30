'use strict';
const { execFile } = require('child_process');

const sh = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, out: `${stdout || ''}${stderr || ''}` }));
});

/** A package's extra.patches entry as the local patch files it names (cweagans v1 map or v2 list). */
const patchUrls = (entry) => (Array.isArray(entry) ? entry.map((e) => (e && typeof e === 'object' ? e.url : e)) : Object.values(entry || {}))
  .filter((u) => typeof u === 'string').map((u) => u.replace(/^\.\//, ''));

/**
 * Commits on {ref} not deployed yet: the last build's source ({since}) and what changed between it
 * and the tip. null when the tip is what was built, or the build's source can't be read (then the
 * heal works on the tip alone, as before).
 * @param {string} since the source commit the built repo's last build names ('' when none)
 * @param {(msg:string)=>void} [warn]
 */
async function undeployed(since, cwd, tip, ref, warn = () => {}) {
  if (!since || since === tip) return null;
  const git = (...args) => sh(args, cwd);
  if ((await git('cat-file', '-e', `${since}^{commit}`)).code !== 0) await git('fetch', '-q', '--no-tags', 'origin', since);
  // CI checkouts are shallow: deepen {ref} back to a day before the build's source, so the ancestry
  // check and the diff see the commits in between (bounded, unlike --unshallow).
  if ((await git('rev-parse', '--is-shallow-repository')).out.trim() === 'true') {
    const when = Number((await git('show', '-s', '--format=%ct', since)).out.trim());
    if (when) await git('fetch', '-q', '--no-tags', `--shallow-since=${when - 86400}`, 'origin', ref);
  }
  if ((await git('merge-base', '--is-ancestor', since, tip)).code !== 0) {
    warn(`The last build's source ${since.slice(0, 7)} is not in ${tip.slice(0, 7)}'s history; healing on the tip only.`);
    return null;
  }
  const jsonAt = async (rev, file) => {
    try { return JSON.parse((await git('show', `${rev}:${file}`)).out) || {}; } catch { return {}; }
  };
  const lockAt = async (rev) => new Map(((await jsonAt(rev, 'composer.lock')).packages || []).map((p) => [p.name, p.version]));
  const [a, b] = [await lockAt(since), await lockAt(tip)];
  const [ja, jb] = [await jsonAt(since, 'composer.json'), await jsonAt(tip, 'composer.json')];
  const files = (await git('diff', '--name-only', since, tip)).out.split('\n').filter(Boolean);
  // A package whose patch the undeployed commits changed (its entry, or a patch file it names) is
  // theirs too, like a version change: the server's edits to it are not fresh drift.
  const [pa, pb] = [(ja.extra || {}).patches || {}, (jb.extra || {}).patches || {}];
  const patched = [...new Set([...Object.keys(pa), ...Object.keys(pb)])].filter((n) => JSON.stringify(pa[n] || null) !== JSON.stringify(pb[n] || null)
    || [...patchUrls(pa[n]), ...patchUrls(pb[n])].some((u) => files.includes(u)));
  return {
    since,
    packages: new Set([...[...a.keys(), ...b.keys()].filter((n) => a.get(n) !== b.get(n)), ...patched]),
    files,
    core: ((ja.extra || {})['wordpress-core'] || '') !== ((jb.extra || {})['wordpress-core'] || ''),
    commits: Number((await git('rev-list', '--count', `${since}..${tip}`)).out.trim()) || 0,
  };
}

module.exports = { undeployed };
