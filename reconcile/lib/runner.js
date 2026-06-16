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
  };
}
module.exports = { makeRunner };
