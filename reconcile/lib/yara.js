'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// signature-base webshell rules (Detection Rule License 1.1), fetched at run time from a pinned
// commit and checked against these sha256 sums: never committed to this repo.
const MANIFEST = require('../yara/signature-base.json');
const HELPER = path.join(__dirname, 'yara-scan.py');
// Always run python with -I: reconcile/yara/ (the manifest dir) would otherwise shadow `import yara` from cwd.

let state = { error: 'rules not loaded' }; // { python, compiled } once prepare() succeeds
let runner = null; // tests inject a stub here

/**
 * Download, verify and compile the rules into dir (an empty directory). Fails closed: on any
 * error scan() reports it, and every server-derived item is held as yara-unavailable.
 * @returns {Promise<string|null>} the cause when the rules are unavailable, else null
 */
async function prepare({ fetch, dir, python = 'python3' }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = await Promise.all(MANIFEST.files.map(async ({ path: p, sha256 }) => {
      const url = `https://raw.githubusercontent.com/${MANIFEST.repo}/${MANIFEST.commit}/${p}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`download of ${p} failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (crypto.createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error(`checksum mismatch for ${p}`);
      const out = path.join(dir, path.basename(p));
      fs.writeFileSync(out, buf);
      return out;
    }));
    const compiled = path.join(dir, 'rules.yarc');
    execFileSync(python, ['-I', HELPER, 'compile', compiled, ...files], { stdio: ['ignore', 'pipe', 'pipe'] });
    state = { python, compiled };
    return null;
  } catch (e) {
    state = { error: cause(e) };
    return state.error;
  }
}

/** The last stderr line of a failed helper (e.g. "No module named 'yara'"), else the message. */
function cause(e) {
  const err = String(e.stderr || '').trim().split('\n').pop();
  return err || e.message;
}

/**
 * Scan whole files and/or text buffers with the compiled rules.
 * @returns {{files:{rule:string,author:string}[][], buffers:{rule:string,author:string}[][]}|{error:string}}
 */
function scan({ files = [], buffers = [] }) {
  if (runner) return runner({ files, buffers });
  if (state.error) return { error: state.error };
  try {
    const out = execFileSync(state.python, ['-I', HELPER, 'scan', state.compiled],
      { input: JSON.stringify({ files, buffers }), maxBuffer: 64 * 1024 * 1024, timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(out);
  } catch (e) {
    return { error: `scan failed: ${cause(e)}` };
  }
}

function setRunner(fn) { runner = fn; }

module.exports = { prepare, scan, setRunner, MANIFEST };
