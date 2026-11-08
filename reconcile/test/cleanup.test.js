'use strict';
// The green-path cleanup step (CLEANUP_ONLY) runs index.js against a fake gh on PATH: every PR
// comment it writes links the run, even though that step's env has no RUN_URL.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const R = 'a'.repeat(40); // the heal the built repo records
const H = 'b'.repeat(40); // the closed engineers' PR's head
const RUN = 'https://github.test/o/r/actions/runs/42';

// gh's answer per call, by the first rule whose pattern matches the joined args ('' otherwise).
const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2);
require('fs').appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const a = args.join(' ');
const rules = [
  [/pulls\\?head=o:reconciliation-main&state=open/, '5'],
  [/pulls\\?head=o:selfheal-undeployed-main&state=closed/, JSON.stringify([{ number: 72, head: '${H}', body: 'old body', merged: false }])],
  [/commits\\/${H}/, 'Build changes\\t'],
  [/compare\\/${R}\\.\\.\\.${H}/, 'ahead'],
  [/compare\\/${R}\\.\\.\\.main/, 'behind'],
  [/git\\/ref\\/heads\\/selfheal-undeployed-main/, '${H}'],
  [/compare\\/${H}\\.\\.\\.${H}/, 'identical'],
  [/^pr create/, 'https://github.test/o/r/pull/73'],
  [/issues\\/72 -q/, 'alice'],
];
const hit = rules.find(([re]) => re.test(a));
process.stdout.write(hit ? hit[1] : '');
`;

test('cleanup step: the stale-PR close and the recovered PR link the run without RUN_URL', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  const bin = path.join(ws, 'bin');
  const built = path.join(ws, 'built');
  fs.mkdirSync(bin);
  fs.mkdirSync(built);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: built });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', `Build changes from ${R}`);
  const log = path.join(ws, 'gh.log');
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GH_LOG: log, RUNNER_TEMP: ws,
    CLEANUP_ONLY: '1', REPO: 'o/r', REF: 'main', BUILT_DIR: built,
    GITHUB_SERVER_URL: 'https://github.test', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '42' };
  delete env.RUN_URL;
  delete env.GITHUB_OUTPUT;
  delete env.GITHUB_STEP_SUMMARY;
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js')], { env, encoding: 'utf8' });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const recovered = path.join(ws, 'reconcile-recovered-main.md');
  const prBody = fs.existsSync(recovered) ? fs.readFileSync(recovered, 'utf8') : '';
  fs.rmSync(ws, { recursive: true, force: true });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  const bodyOf = (re) => (calls.find((c) => re.test(c.join(' '))) || []).find((x) => /^body=/.test(x)) || '';
  const link = `From the [consistency check run](${RUN}).`;
  assert.ok(bodyOf(/issues\/5\/comments/).startsWith('body=Closed by consistency self-heal: '), JSON.stringify(calls));
  assert.ok(bodyOf(/issues\/5\/comments/).endsWith(link), bodyOf(/issues\/5\/comments/));
  assert.ok(bodyOf(/issues\/72\/comments/).endsWith(link), bodyOf(/issues\/72\/comments/));
  assert.ok(calls.some((c) => c[0] === 'pr' && c[1] === 'create'), JSON.stringify(calls));
  assert.ok(prBody.includes(`Opened by the [consistency check run](${RUN}).`), prBody);
});
