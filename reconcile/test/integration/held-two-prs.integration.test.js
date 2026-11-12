'use strict';
// G65 (owner, 2026-11-10), index.js end to end against a local origin and a fake gh: a held heal while
// an engineer's commit is undeployed. Run 1 opens PR 1 (reconciliation-main, head r1 on D, base
// selfheal-base-main created at D). The reviewer merges it (m1 = merge(D, r1)). Run 2 records m1 (build-sha,
// auto-merge for the verify job) and opens the engineers' PR from selfheal-undeployed-main into main, routed
// to the commit's author, then deletes selfheal-base-main.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { makeProject } = require('../helpers/make-project');
const { stageServer, deriveDrift } = require('../helpers/stage-server');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(a) + '\\n');
const rules = JSON.parse(fs.readFileSync(process.env.GH_RULES, 'utf8'));
const i = rules.findIndex(([re]) => new RegExp(re).test(a.join(' ')));
const hit = rules[i];
let v = hit ? hit[1] : '';
if (Array.isArray(v)) { // answers in turn, the last one repeated
  const f = process.env.GH_RULES + '.' + i; const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
  fs.writeFileSync(f, String(n + 1)); v = v[Math.min(n, v.length - 1)];
}
process.stdout.write(v);
process.exit(hit && hit[2] ? hit[2] : 0);
`;

test('held heal + undeployed commit: PR 1 into selfheal-base-main, then its merge is recorded and routed to the engineers', () => {
  const { dir: proj } = makeProject({ plugins: [{ slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' }] });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'held-two-'));
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
  try {
    // D: the project with a committed custom plugin (tracked: healed by copying the server's version).
    fs.writeFileSync(path.join(proj, '.gitignore'), 'vendor/\npkgs/\nplugins/*\n!plugins/customx/\n');
    fs.mkdirSync(path.join(proj, 'plugins/customx'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'plugins/customx/customx.php'), '<?php\n/* Plugin Name: customx */\nfunction customx() { return 1; }\n');
    fs.writeFileSync(path.join(proj, 'README.md'), 'site\n');
    G(proj, 'init', '-q', '-b', 'main'); G(proj, 'add', '-A'); G(proj, 'commit', '-qm', 'D');
    const D = G(proj, 'rev-parse', 'HEAD');
    const origin = path.join(ws, 'origin.git');
    G(ws, 'init', '-q', '--bare', origin);
    G(proj, 'remote', 'add', 'origin', origin); G(proj, 'push', '-q', 'origin', 'main');
    // The server: D's build plus a merchant edit to the custom plugin; the built repo records D.
    const server = stageServer(proj, (sv) => fs.writeFileSync(path.join(sv, 'plugins/customx/customx.php'), '<?php\n/* Plugin Name: customx */\nfunction customx() { return 2; }\n'));
    const { manifestText, contentDiffText } = deriveDrift(proj, server);
    G(server, 'init', '-q'); G(server, 'commit', '-q', '--allow-empty', '-m', `Build changes from ${D}`);
    fs.writeFileSync(path.join(ws, 'manifest.txt'), manifestText);
    fs.writeFileSync(path.join(ws, 'diff.txt'), contentDiffText);
    // u1: an engineer's commit on main, not deployed.
    fs.writeFileSync(path.join(proj, 'README.md'), 'site, by an engineer\n');
    G(proj, 'commit', '-qam', 'u1'); G(proj, 'push', '-q', 'origin', 'main');
    const U = G(proj, 'rev-parse', 'HEAD');
    G(proj, 'checkout', '-q', D); // the check's checkout is wherever; index.js recreates its branches from origin

    fs.mkdirSync(path.join(ws, 'bin'));
    fs.writeFileSync(path.join(ws, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
    const run = (n, rules, extra = {}) => {
      const log = path.join(ws, `gh-${n}.log`);
      const out = path.join(ws, `out-${n}`);
      fs.writeFileSync(out, '');
      for (const f of fs.readdirSync(ws)) if (f.startsWith('rules.json')) fs.rmSync(path.join(ws, f));
      fs.writeFileSync(path.join(ws, 'rules.json'), JSON.stringify(rules));
      const env = { ...process.env, PATH: path.join(ws, 'bin') + path.delimiter + process.env.PATH, GH_LOG: log, GH_RULES: path.join(ws, 'rules.json'),
        RUNNER_TEMP: ws, GITHUB_OUTPUT: out, REPO: 'o/r', REF: 'main', SOURCE_DIR: proj, BUILT_DIR: server, RUN_URL: 'https://run',
        MANIFEST_PATH: path.join(ws, 'manifest.txt'), DIFF_PATH: path.join(ws, 'diff.txt'), RECONCILE_MERGE: '0',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      env.GITHUB_STEP_SUMMARY = path.join(ws, `summary-${n}`); fs.writeFileSync(env.GITHUB_STEP_SUMMARY, '');
      delete env.SAPP_SERVER;
      Object.assign(env, extra);
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'index.js')], { env, encoding: 'utf8' });
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).join(' ')) : [];
      const outputs = {};
      for (const m of fs.readFileSync(out, 'utf8').matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
      return { r, calls, outputs, why: `${r.stdout}\n${r.stderr}\n${calls.join('\n')}` };
    };
    const tipLists = [['selfheal-undeployed-main&state=(open|closed)&per_page', '[]']];

    // Run 1: held (auto-merge off) with u1 undeployed -> PR 1.
    const one = run(1, [...tipLists, ['pr create', 'https://github.test/o/r/pull/12']]);
    const at1 = (re) => one.calls.findIndex((c) => re.test(c));
    assert.ok(at1(new RegExp(`POST repos/o/r/git/refs -f ref=refs/heads/selfheal-base-main -f sha=${D}`)) >= 0, one.why);
    assert.ok(at1(/pr create -R o\/r --head reconciliation-main --base selfheal-base-main /) > at1(/git\/refs -f ref=refs\/heads\/selfheal-base-main/), one.why);
    assert.ok(!one.calls.some((c) => /selfheal-undeployed-main --base|issues\/\d+\/assignees/.test(c)), one.why);
    const r1 = G(origin, 'rev-parse', 'reconciliation-main');
    assert.strictEqual(G(origin, 'rev-parse', `${r1}^`), D, 'PR 1 head is r1 on D');
    assert.strictEqual(G(origin, 'diff', '--name-only', D, r1), 'plugins/customx/customx.php', 'PR 1 diff is the heal alone');
    assert.match(G(origin, 'log', '-1', '--format=%s', r1), /^Reconcile server drift on main \[commit only\]$/);
    assert.strictEqual(one.outputs['auto-merge'], 'false', one.why);
    assert.strictEqual(one.outputs['build-sha'] || '', '', one.why);
    assert.ok(!one.outputs['undeployed-pr'], one.why);
    assert.match(fs.readFileSync(path.join(ws, 'reconcile-body-main.md'), 'utf8'), /This PR reviews only the heal.*`selfheal-base-main`/);
    assert.ok(!G(origin, 'branch', '--list', 'selfheal-undeployed-main'));

    const del = (calls) => calls.findIndex((c) => /-X DELETE repos\/o\/r\/git\/refs\/heads\/selfheal-base-main$/.test(c));
    const create = (calls) => calls.findIndex((c) => new RegExp(`POST repos/o/r/git/refs -f ref=refs/heads/selfheal-base-main -f sha=${D}`).test(c));
    const prOne = (calls) => calls.findIndex((c) => /pr create -R o\/r --head reconciliation-main --base selfheal-base-main /.test(c));
    const openPr1 = ['pulls\\?head=o:reconciliation-main&state=open -q \\.\\[0\\] //', JSON.stringify({ number: 12, body: '' })];

    // Run 1b: the next check while PR 1 waits: updated in place (same head, no push, base kept at D).
    const oneB = run('1b', [...tipLists, ['git/ref/heads/selfheal-base-main', D], ['pulls\\?base=selfheal-base-main&state=open', '1'], openPr1]);
    assert.ok(oneB.calls.some((c) => /PATCH repos\/o\/r\/pulls\/12 .* -f base=selfheal-base-main$/.test(c)), oneB.why);
    assert.ok(!oneB.calls.some((c) => /pr create|git\/refs -f ref=|-X DELETE/.test(c)), oneB.why);
    assert.match(oneB.r.stdout, /reconciliation-main already holds this reconciliation/);
    assert.strictEqual(G(origin, 'rev-parse', 'reconciliation-main'), r1);

    // Run 1c: PR 1 closed unmerged: its base (at D, in main, no PR targeting it) is deleted, created again at D,
    // and a NEW PR opens on it (the closed one is never reused).
    const oneC = run('1c', [...tipLists, ['git/ref/heads/selfheal-base-main', [D, '']], ['pulls\\?base=selfheal-base-main&state=open', '0'],
      [`compare/${D}\\.\\.\\.main`, 'ahead'], ['pr create', 'https://github.test/o/r/pull/15']]);
    assert.ok(del(oneC.calls) >= 0 && create(oneC.calls) > del(oneC.calls) && prOne(oneC.calls) > create(oneC.calls), oneC.why);
    assert.ok(!oneC.calls.some((c) => /pulls\/12/.test(c)), oneC.why);

    // The reviewer merges PR 1 (merge button: a 2-parent merge commit on selfheal-base-main).
    G(origin, 'branch', 'selfheal-base-main', D);
    const tmp = path.join(ws, 'review');
    G(ws, 'clone', '-q', '-b', 'selfheal-base-main', origin, tmp);
    G(tmp, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from o/reconciliation-main', `origin/reconciliation-main`);
    G(tmp, 'push', '-q', 'origin', 'selfheal-base-main');
    const m1 = G(origin, 'rev-parse', 'selfheal-base-main');
    const merged12 = [`pulls\\?base=selfheal-base-main&state=closed`, JSON.stringify({ number: 12, head: r1, merge: m1 })];
    const rejected = (runRes, num, why) => {
      const at = (re) => runRes.calls.findIndex((c) => re.test(c));
      assert.ok(del(runRes.calls) >= 0 && create(runRes.calls) > del(runRes.calls) && prOne(runRes.calls) > create(runRes.calls), runRes.why);
      assert.ok(!runRes.outputs['build-sha'] && !runRes.outputs['undeployed-pr'], runRes.why);
      assert.ok(!runRes.calls.some((c) => /force=true/.test(c)), runRes.why);
      assert.ok(at(new RegExp(`issues/12/comments -f body=This merge \\(${m1.slice(0, 7)}\\) was not accepted as the reviewed heal because ${why}\\. Nothing was recorded; a new PR #${num} asks for review again\\. From the \\[consistency check run\\]\\(https://run\\)\\.$`)) > prOne(runRes.calls), runRes.why);
    };

    // Run 2a: the server changed again after the review: m1 is not what it runs, so nothing is recorded; the
    // stale base is dropped (no fast-forward from m1 to D) and a NEW PR 1 reviews the heal built on D.
    const php = path.join(server, 'plugins/customx/customx.php');
    const reviewedPhp = fs.readFileSync(php, 'utf8');
    fs.writeFileSync(php, reviewedPhp.replace('return 2', 'return 3'));
    fs.writeFileSync(path.join(ws, 'diff.txt'), deriveDrift(proj, server).contentDiffText);
    const twoA = run('2a', [...tipLists, ['git/ref/heads/selfheal-base-main', m1], [`PATCH repos/o/r/git/refs/heads/selfheal-base-main`, 'not a fast forward', 1],
      merged12, ['pr create', 'https://github.test/o/r/pull/14']]);
    rejected(twoA, 14, 'the server changed since the review: it no longer runs this heal');
    fs.writeFileSync(php, reviewedPhp);
    fs.writeFileSync(path.join(ws, 'diff.txt'), contentDiffText);

    // Run 2b: a commit pushed to selfheal-base-main on top of m1: not PR 1's merge any more, rejected the same way.
    G(tmp, 'commit', '-q', '--allow-empty', '-m', 'stray'); G(tmp, 'push', '-q', 'origin', 'selfheal-base-main');
    const m1plus = G(origin, 'rev-parse', 'selfheal-base-main');
    const twoB = run('2b', [...tipLists, ['git/ref/heads/selfheal-base-main', m1plus], [`PATCH repos/o/r/git/refs/heads/selfheal-base-main`, 'not a fast forward', 1],
      merged12, ['pr create', 'https://github.test/o/r/pull/16']]);
    rejected(twoB, 16, `commits were pushed to the base branch on top of its merge ${m1.slice(0, 7)}`);

    // Run 2c: PR 1 merged during the run (git saw the base at D, GitHub now says m1): kept, no PR, the next
    // check takes the merge. 2d: the API could not answer about the merged PR: kept the same way.
    G(origin, 'update-ref', 'refs/heads/selfheal-base-main', D);
    const twoC = run('2c', [...tipLists, ['git/ref/heads/selfheal-base-main', m1], merged12]);
    assert.ok(del(twoC.calls) < 0 && create(twoC.calls) < 0 && !twoC.calls.some((c) => /pr create|PATCH repos\/o\/r\/git\/refs/.test(c)), twoC.why);
    assert.match(twoC.r.stdout, /could not be judged this run/);
    G(origin, 'update-ref', 'refs/heads/selfheal-base-main', m1);
    const twoD = run('2d', [...tipLists, ['git/ref/heads/selfheal-base-main', m1], [`pulls\\?base=selfheal-base-main&state=closed`, 'HTTP 502', 1]]);
    assert.ok(del(twoD.calls) < 0 && !twoD.calls.some((c) => /pr create|PATCH repos\/o\/r\/git\/refs/.test(c)), twoD.why);
    assert.match(twoD.r.stdout, /could not be judged this run/);
    assert.ok(!G(origin, 'branch', '--list', 'selfheal-undeployed-main'));

    // Run 2: the follow-up check (server unchanged, the record still D).
    const two = run(2, [...tipLists, merged12,
      ['compare/', 'alice'], ['api user', 'bot'], ['pr create', 'https://github.test/o/r/pull/13']]);
    const at2 = (re) => two.calls.findIndex((c) => re.test(c));
    assert.ok(at2(/pr create -R o\/r --head selfheal-undeployed-main --base main /) >= 0, two.why);
    assert.ok(at2(/issues\/13\/labels -f labels\[\]=self-heal\/undeployed/) >= 0, two.why);
    assert.ok(at2(/issues\/13\/assignees -f assignees\[\]=alice/) >= 0, two.why);
    assert.strictEqual(two.outputs['build-sha'], m1, `records m1\n${two.why}`);
    assert.strictEqual(two.outputs['auto-merge'], 'true', two.why); // the verify job runs and records it
    assert.strictEqual(two.outputs['undeployed-pr'], '13', two.why);
    assert.strictEqual(two.outputs.engineers, '@alice', two.why);
    const head = G(origin, 'rev-parse', 'selfheal-undeployed-main');
    assert.strictEqual(head, m1, 'no conflict with u1: the engineers\' PR head is m1 itself');
    assert.strictEqual(two.outputs['head-sha'], head);
    assert.strictEqual(G(origin, 'merge-tree', '--write-tree', U, head).split('\n')[0].length, 40, 'merges cleanly with main');
    assert.match(fs.readFileSync(path.join(ws, 'reconcile-body-main.md'), 'utf8'), /reviewed in #12; its merge `.{7}` is what the built repo records/);
    assert.ok(two.calls.some((c) => /issues\/12\/comments -f body=The heal merged here .* went to the engineers in #13\. `selfheal-base-main` is deleted once that record lands\. From the \[consistency check run\]\(https:\/\/run\)\.$/.test(c)), two.why);
    // N3: the base stays until m1 is recorded (a failed verify re-records without a new review).
    assert.ok(del(two.calls) < 0, two.why);
    assert.ok(create(two.calls) < 0 && !two.calls.some((c) => /pr create .*--base selfheal-base-main/.test(c)), two.why);

    // Run 3: the green check after verify recorded m1: the base goes.
    G(server, 'commit', '-q', '--allow-empty', '-m', `Build changes from ${m1}`);
    const three = run(3, [...tipLists, ['git/ref/heads/selfheal-base-main', m1], ['pulls\\?base=selfheal-base-main&state=open', '0']], { CLEANUP_ONLY: '1' });
    assert.ok(del(three.calls) >= 0 && del(three.calls) < three.calls.findIndex((c) => /pulls\?head=o:reconciliation-main&state=open/.test(c)), three.why);

    // Run 4 (M9): the undeployed commits are gone (the record is main's tip): the open held PR is retargeted to
    // main, then selfheal-base-main is deleted.
    G(server, 'commit', '-q', '--allow-empty', '-m', `Build changes from ${U}`);
    const four = run(4, [...tipLists, openPr1]);
    const patch = four.calls.findIndex((c) => /PATCH repos\/o\/r\/pulls\/12 .* -f base=main$/.test(c));
    assert.ok(patch >= 0 && del(four.calls) > patch, four.why);
    assert.ok(create(four.calls) < 0, four.why);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test('ADV-I1: new eligible drift after PR 1 merged never splits past m1: the base is judged, PR 1 told why, then dropped', () => {
  const { dir: proj } = makeProject({ plugins: [{ slug: 'baseplug', pkg: 'saucal/baseplug', version: '1.0.0', body: '// base\n' }] });
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'held-two-i1-'));
  const G = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }).trim();
  const plug = (dir, slug, ret) => {
    fs.mkdirSync(path.join(dir, 'plugins', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugins', slug, `${slug}.php`), `<?php\n/* Plugin Name: ${slug} */\nfunction ${slug}() { return ${ret}; }\n`);
  };
  try {
    // D tracks two custom plugins; u1 is undeployed.
    fs.writeFileSync(path.join(proj, '.gitignore'), 'vendor/\npkgs/\nplugins/*\n!plugins/customx/\n!plugins/heldx/\n');
    plug(proj, 'customx', '1'); plug(proj, 'heldx', '1');
    fs.writeFileSync(path.join(proj, 'README.md'), 'site\n');
    G(proj, 'init', '-q', '-b', 'main'); G(proj, 'add', '-A'); G(proj, 'commit', '-qm', 'D');
    const D = G(proj, 'rev-parse', 'HEAD');
    const origin = path.join(ws, 'origin.git');
    G(ws, 'init', '-q', '--bare', origin);
    G(proj, 'remote', 'add', 'origin', origin); G(proj, 'push', '-q', 'origin', 'main');
    // Phase 1: heldx gains an external URL (held for review).
    const server = stageServer(proj, (sv) => plug(sv, 'heldx', "'https://example.com'"));
    const drift = () => {
      const d = deriveDrift(proj, server);
      fs.writeFileSync(path.join(ws, 'manifest.txt'), d.manifestText);
      fs.writeFileSync(path.join(ws, 'diff.txt'), d.contentDiffText);
    };
    drift();
    G(server, 'init', '-q'); G(server, 'commit', '-q', '--allow-empty', '-m', `Build changes from ${D}`);
    fs.writeFileSync(path.join(proj, 'README.md'), 'site, by an engineer\n');
    G(proj, 'commit', '-qam', 'u1'); G(proj, 'push', '-q', 'origin', 'main');
    G(proj, 'checkout', '-q', D);

    fs.mkdirSync(path.join(ws, 'bin'));
    fs.writeFileSync(path.join(ws, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
    const run = (n, rules) => {
      const log = path.join(ws, `gh-${n}.log`);
      const out = path.join(ws, `out-${n}`);
      fs.writeFileSync(out, '');
      for (const f of fs.readdirSync(ws)) if (f.startsWith('rules.json')) fs.rmSync(path.join(ws, f));
      fs.writeFileSync(path.join(ws, 'rules.json'), JSON.stringify(rules));
      const env = { ...process.env, PATH: path.join(ws, 'bin') + path.delimiter + process.env.PATH, GH_LOG: log, GH_RULES: path.join(ws, 'rules.json'),
        RUNNER_TEMP: ws, GITHUB_OUTPUT: out, REPO: 'o/r', REF: 'main', SOURCE_DIR: proj, BUILT_DIR: server, RUN_URL: 'https://run',
        MANIFEST_PATH: path.join(ws, 'manifest.txt'), DIFF_PATH: path.join(ws, 'diff.txt'), RECONCILE_MERGE: '1',
        GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      env.GITHUB_STEP_SUMMARY = path.join(ws, `summary-${n}`); fs.writeFileSync(env.GITHUB_STEP_SUMMARY, '');
      delete env.SAPP_SERVER;
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'index.js')], { env, encoding: 'utf8' });
      const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).join(' ')) : [];
      const outputs = {};
      for (const m of fs.readFileSync(out, 'utf8').matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
      return { r, calls, outputs, why: `${r.stdout}\n${r.stderr}\n${calls.join('\n')}` };
    };
    const tipLists = [['selfheal-undeployed-main&state=(open|closed)&per_page', '[]']];

    // Run 1: heldx is held -> PR 1 (#12) into selfheal-base-main.
    const one = run(1, [...tipLists, ['pr create', 'https://github.test/o/r/pull/12']]);
    assert.ok(one.calls.some((c) => /pr create -R o\/r --head reconciliation-main --base selfheal-base-main /.test(c)), one.why);
    const r1 = G(origin, 'rev-parse', 'reconciliation-main');

    // The reviewer merges PR 1 (m1); then customx drifts on the server too (needs no review).
    G(origin, 'branch', 'selfheal-base-main', D);
    const tmp = path.join(ws, 'review');
    G(ws, 'clone', '-q', '-b', 'selfheal-base-main', origin, tmp);
    G(tmp, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #12 from o/reconciliation-main', 'origin/reconciliation-main');
    G(tmp, 'push', '-q', 'origin', 'selfheal-base-main');
    const m1 = G(origin, 'rev-parse', 'selfheal-base-main');
    plug(server, 'customx', '2');
    G(proj, 'checkout', '-q', '-f', D); // the drift is against D: run 1 left the checkout on its branch
    drift();

    // Run 2: no mixed split past m1. The server no longer runs the reviewed heal alone, so m1 is not taken:
    // PR 1 says why (with the run link), the base is dropped and recreated at D, and a new PR 1 reviews both.
    const two = run(2, [...tipLists, ['git/ref/heads/selfheal-base-main', m1], ['PATCH repos/o/r/git/refs/heads/selfheal-base-main', 'not a fast forward', 1],
      ['pulls\\?base=selfheal-base-main&state=closed', JSON.stringify({ number: 12, head: r1, merge: m1 })], ['pr create', 'https://github.test/o/r/pull/14']]);
    const at = (re) => two.calls.findIndex((c) => re.test(c));
    assert.doesNotMatch(two.r.stdout, /Mixed heal/, two.why);
    assert.ok(!two.outputs['build-sha'] && !two.outputs['undeployed-pr'], two.why);
    assert.strictEqual(two.outputs['auto-merge'], 'false', two.why);
    assert.ok(!two.calls.some((c) => /selfheal-undeployed-main --base|force=true/.test(c)), two.why);
    const del = at(/-X DELETE repos\/o\/r\/git\/refs\/heads\/selfheal-base-main$/);
    const create = at(new RegExp(`POST repos/o/r/git/refs -f ref=refs/heads/selfheal-base-main -f sha=${D}`));
    const pr = at(/pr create -R o\/r --head reconciliation-main --base selfheal-base-main /);
    assert.ok(del >= 0 && create > del && pr > create, two.why);
    assert.ok(at(new RegExp(`issues/12/comments -f body=This merge \\(${m1.slice(0, 7)}\\) was not accepted as the reviewed heal because the server changed since the review: it no longer runs this heal\\. Nothing was recorded; a new PR #14 asks for review again\\. From the \\[consistency check run\\]\\(https://run\\)\\.$`)) > pr, two.why);
    const r2 = G(origin, 'rev-parse', 'reconciliation-main');
    assert.strictEqual(G(origin, 'rev-parse', `${r2}^`), D);
    assert.deepStrictEqual(G(origin, 'diff', '--name-only', D, r2).split('\n').sort(), ['plugins/customx/customx.php', 'plugins/heldx/heldx.php'], 'the new PR 1 reviews both');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});
