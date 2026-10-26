'use strict';
const { execFile } = require('child_process');

/** Real runner: thin promisified wrappers around composer/git. Inject a fake in unit tests. */
function makeRunner() {
  function run(cmd, args, opts = {}) {
    return new Promise((resolve) => {
      execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  }
  return {
    composer: (args, opts) => run('composer', [...args, '--no-interaction'], opts),
    git: (args, opts) => run('git', args, opts),
    run,
    // wpackagist's per-package Refresh button (POST /update): its mirror can lag wordpress.org by weeks.
    async refreshWpackagist(slug, waitMs = 5000) {
      try {
        await fetch('https://wpackagist.org/update', { method: 'POST', body: new URLSearchParams({ name: slug }), redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (saucal consistency reconcile)' } });
      } catch { return false; }
      await new Promise((r) => setTimeout(r, waitMs));
      return true;
    },
  };
}
module.exports = { makeRunner };
