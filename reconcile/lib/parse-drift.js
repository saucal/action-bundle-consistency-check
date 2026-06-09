'use strict';

const NOISE_RE = /^cannot delete non-empty directory:/;

/**
 * Parse an rsync sync-plan / manifest buffer into drift items.
 * @param {string} text
 * @returns {import('./classify').DriftItem[]}
 */
function parseManifest(text) {
  const items = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;       // header block in newer artifacts
    if (NOISE_RE.test(line)) continue;        // rsync stderr noise
    if (line.endsWith('/')) continue;         // directories
    if (line.startsWith('deleting ')) {
      items.push({ path: line.slice('deleting '.length), side: 'remote-only' });
    } else {
      items.push({ path: line, side: 'build-only' });
    }
  }
  return items;
}

module.exports = { parseManifest };
