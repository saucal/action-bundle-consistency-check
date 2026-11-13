'use strict';
// Exercise the entry point's actual PR body, job summary and Slack output against local git and gh.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { TEXTBOOK } = require('./helpers/yara-stub');

function scenario({ prepareError = null, scanError = null, malicious = true }) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-outage-'));
  const source = path.join(ws, 'source');
  const built = path.join(ws, 'built');
  const bin = path.join(ws, 'bin');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  try {
    for (const dir of [source, built]) fs.mkdirSync(path.join(dir, 'plugins/custom'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(source, 'composer.json'), '{"name":"t/t","require":{}}\n');
    fs.writeFileSync(path.join(source, 'plugins/custom/main.php'), '<?php echo 1;\n');
    fs.writeFileSync(path.join(built, 'plugins/custom/main.php'), '<?php\n' + (malicious ? TEXTBOOK : 'echo 2;') + '\n');
    git(source, 'init', '-q', '-b', 'main'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'deployed');
    const deployed = git(source, 'rev-parse', 'HEAD');
    git(ws, 'init', '-q', '--bare', path.join(ws, 'origin.git'));
    git(source, 'remote', 'add', 'origin', path.join(ws, 'origin.git')); git(source, 'push', '-q', 'origin', 'main');
    git(built, 'init', '-q'); git(built, 'commit', '-q', '--allow-empty', '-m', `Build changes from ${deployed}`);
    fs.writeFileSync(path.join(ws, 'manifest'), 'plugins/custom/main.php\n');
    fs.writeFileSync(path.join(ws, 'output'), ''); fs.writeFileSync(path.join(ws, 'summary'), '');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
process.stdout.write(args.startsWith('pr create ') ? 'https://github.test/o/r/pull/7' : /selfheal-undeployed-main&state=/.test(args) ? '[]' : '');
`, { mode: 0o755 });
    fs.writeFileSync(path.join(ws, 'preload.js'), `
const yara = require(${JSON.stringify(require.resolve('../lib/yara'))});
const { stub } = require(${JSON.stringify(require.resolve('./helpers/yara-stub'))});
yara.prepare = async () => ${JSON.stringify(prepareError)};
yara.setRunner(${JSON.stringify(scanError)} ? () => ({ error: ${JSON.stringify(scanError)} }) : stub);
require(${JSON.stringify(require.resolve('../lib/resolvers'))}).makeResolvers = () => ({ async wpackagist() { return null; }, async satispress() { return null; } });
require(${JSON.stringify(require.resolve('../lib/runner'))}).makeRunner = () => ({ composer() { return { code: 0, stdout: '', stderr: '' }; } });
`);
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RUNNER_TEMP: ws,
      SOURCE_DIR: source, BUILT_DIR: built, MANIFEST_PATH: path.join(ws, 'manifest'), DIFF_PATH: '',
      GITHUB_OUTPUT: path.join(ws, 'output'), GITHUB_STEP_SUMMARY: path.join(ws, 'summary'),
      REPO: 'o/r', REF: 'main', RECONCILE_MERGE: '0', RUN_URL: 'https://run' };
    delete env.SAPP_SERVER; delete env.CLEANUP_ONLY;
    const run = spawnSync(process.execPath, ['--require', path.join(ws, 'preload.js'), path.join(__dirname, '..', 'index.js')], { env, encoding: 'utf8' });
    const outputs = {};
    for (const m of fs.readFileSync(path.join(ws, 'output'), 'utf8').matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
    const bodyFile = path.join(ws, 'reconcile-body-main.md');
    return { run, outputs, body: fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '', summary: fs.readFileSync(path.join(ws, 'summary'), 'utf8') };
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
}

for (const [name, options, cause] of [
  ['rules could not load', { prepareError: 'checksum mismatch', scanError: 'checksum mismatch' }, 'checksum mismatch'],
  ['helper failed after the rules loaded', { scanError: 'scan failed: helper timed out' }, 'scan failed: helper timed out'],
]) {
  test(`scanner outage: ${name} is prominent in the PR, summary and Slack output`, () => {
    const { run, outputs, body, summary } = scenario(options);
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.strictEqual(outputs['auto-merge'], 'false');
    assert.strictEqual(outputs.suspicious, 'false', 'an outage is not a positive malware finding');
    const warning = `Webshell scan did not run: ${cause} — do not merge until a check with the scanner passes.`;
    assert.strictEqual(outputs['webshell-scan-warning'], warning);
    assert.ok(body.startsWith('## 🚨 ' + warning), body);
    assert.ok(summary.startsWith('## 🚨 ' + warning), summary);
    assert.ok(!body.slice(body.indexOf('<details>')).includes('— yara-unavailable'), body);
    assert.match(run.stdout, /Every run with server-derived content is affected until the scanner is fixed/);
    assert.match(run.stdout, /Install yara-python for reconcile/);
  });
}

test('working scanner: clean content has no outage warning', () => {
  const { run, outputs, body } = scenario({ malicious: false });
  assert.strictEqual(run.status, 0, run.stdout + run.stderr);
  assert.strictEqual(outputs['webshell-scan-warning'], '');
  assert.doesNotMatch(body, /Webshell scan did not run/);
});

test('working scanner: a webshell still reports a compromise, without an outage warning', () => {
  const { outputs, summary } = scenario({});
  assert.strictEqual(outputs.suspicious, 'true');
  assert.strictEqual(outputs['webshell-scan-warning'], '');
  assert.match(summary, /Security review required/);
  assert.doesNotMatch(summary, /Webshell scan did not run/);
});
