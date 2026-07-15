'use strict';
const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const path = require('path');
const { makeResolvers } = require('./lib/resolvers');
const { reportBody } = require('./lib/report');
const { reconcileRun } = require('./lib/reconcile-run');
const { makeRunner } = require('./lib/runner');

function env(name, def = '') { return process.env[name] || def; }

/** DIFF_PATH is a directory of reverse-diff files (getRsyncDiff) or a single file; concat all. */
function readDiff(diffPath) {
  if (!diffPath || !fs.existsSync(diffPath)) return '';
  const st = fs.statSync(diffPath);
  if (st.isDirectory()) {
    return fs.readdirSync(diffPath)
      .map((f) => { try { return fs.readFileSync(path.join(diffPath, f), 'utf8'); } catch { return ''; } })
      .join('\n');
  }
  return fs.readFileSync(diffPath, 'utf8');
}

async function sh(cmd, args, opts = {}) {
  let out = '';
  const code = await exec.exec(cmd, args, {
    ignoreReturnCode: true,
    listeners: { stdout: (d) => { out += d.toString(); }, stderr: (d) => { out += d.toString(); } },
    ...opts,
  });
  return { code, out };
}

(async function main() {
  const ref = env('REF');
  const repo = env('REPO');
  const sourceDir = env('SOURCE_DIR', 'source');
  const treeRoot = env('BUILT_DIR', 'built');
  const manifestPath = env('MANIFEST_PATH');
  const diffPath = env('DIFF_PATH');
  const runUrl = env('RUN_URL');
  const adopt = /^(1|true)$/i.test(env('ADOPT_NON_COMPOSER'));
  const branch = `reconciliation-${ref}`;
  // Composer SatisPress auth is configured by the action step (composer config --global --auth)
  // before this script runs, so every composer subprocess here reads it from auth.json.

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    core.warning('No drift manifest available; nothing to reconcile.');
    return;
  }
  if (!ref) { core.setFailed('REF is required.'); return; }
  if (!repo) { core.setFailed('REPO is required.'); return; }

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const contentDiffText = readDiff(diffPath);

  // 1. Recreate the reconciliation branch from the latest {ref} FIRST, so every applied
  //    change (composer.json/lock, patches) lands on the branch — composer install/patch
  //    runs against this clean source tree rather than being discarded by a later checkout.
  const cwd = sourceDir;
  await sh('git', ['config', 'user.name', 'saucal-ci'], { cwd });
  await sh('git', ['config', 'user.email', 'ci@saucal.com'], { cwd });
  const fetched = await sh('git', ['fetch', 'origin', ref], { cwd });
  if (fetched.code !== 0) { core.setFailed(`git fetch failed:\n${fetched.out}`); return; }
  const checkedOut = await sh('git', ['checkout', '-B', branch, `origin/${ref}`], { cwd });
  if (checkedOut.code !== 0) { core.setFailed(`git checkout failed:\n${checkedOut.out}`); return; }

  // 2. Classify + apply (composer add/bump + patches) via the orchestrator core.
  // SatisPress resolution goes through composer itself (`composer show`), reusing the SAME
  // auth.json action-composer-auth already configured earlier in this job — no separate
  // credential handling for the resolver.
  const runner = makeRunner();
  const resolvers = makeResolvers({ fetch, runner, cwd });
  let result;
  try {
    result = await reconcileRun({ sourceDir, treeRoot, manifestText, contentDiffText, resolvers, runner, adopt });
  } catch (e) {
    core.setFailed(`reconcile-run failed: ${e.stack || e}`);
    return;
  }
  const { classified, outcome, applied, verification } = result;
  core.info(`Reconcile outcome: ${outcome} | applied: ${applied.join(', ') || '(none)'}`);

  // Where we land: verified = a deploy from this PR reproduces the server for that component;
  // residual = still differs after apply. Compared locally against the server state the check
  // already captured — no second rsync.
  if (verification && verification.verifiable) {
    core.info(`Verified ${verification.verified}/${verification.verifiable} recovered components reproduce the server; ${verification.residual} with residual drift.`);
    for (const c of classified) {
      if (c.verified === false) {
        core.warning(`${c.key}: applied, but ${c.residualFiles} file(s) still differ from the server after apply — the fix does not fully converge here.`);
      }
    }
  }

  // Surface composer's actual complaint for anything flagged unavailable (why the version
  // couldn't be installed: missing version, stability, or a broken global solve).
  for (const c of classified) {
    if (c.category === 'version-unavailable' && c.composerOutput) {
      core.warning(`composer could not install ${c.composerPackage}:\n${c.composerOutput}`);
    }
  }

  const body = reportBody(classified, { ref, runUrl });

  if (outcome === 'noop') {
    await core.summary.addRaw('## Consistency reconciliation\n\nNo actionable drift classified (all manifest entries were noise/directories).').write();
    core.warning('No actionable drift classified.');
    return;
  }

  // 3. Stage ONLY the reconcile outputs — not `git add -A`, which would also commit
  //    build-injected files (mu-plugins, generated drop-ins) that aren't source changes.
  const OUTPUT_PATHS = ['composer.json', 'composer.lock', 'patches', 'patches.lock.json', '.patches_applied'];
  const toStage = OUTPUT_PATHS.filter((p) => fs.existsSync(path.join(cwd, p)));
  if (toStage.length) await sh('git', ['add', '--', ...toStage], { cwd });
  // Force-add adopted (vendored) component dirs — plugins/ is typically gitignored for
  // composer-managed installs, so a plain `git add` would skip the newly-vendored source.
  for (const root of (result.adoptedPaths || [])) {
    await sh('git', ['add', '-f', '--', root], { cwd });
  }
  const staged = await sh('git', ['diff', '--cached', '--name-only'], { cwd });
  if (!staged.out.trim()) {
    await core.summary.addRaw(body).write();
    if (outcome === 'ignorable-only') {
      core.warning('Drift is entirely ignorable. Recommend updating SSH_IGNORE_LIST; see job summary.');
    }
    core.setFailed(`Consistency drift produced no committable source change (${outcome}).`);
    return;
  }

  const committed = await sh('git', ['commit', '-m', `chore: reconcile server drift on ${ref}`], { cwd });
  if (committed.code !== 0) { core.setFailed(`git commit failed:\n${committed.out}`); return; }
  const push = await sh('git', ['push', '--force', 'origin', branch], { cwd });
  if (push.code !== 0) { core.setFailed(`git push failed:\n${push.out}`); return; }

  // 4. Upsert the PR via gh (GH_TOKEN is in env).
  const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-body-${ref}.md`);
  fs.writeFileSync(bodyFile, body);
  const title = `Reconcile server drift on ${ref}`;
  const existing = await sh('gh', ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
  if (existing.out.trim()) {
    // Use the REST API (needs only `repo` scope) instead of `gh pr edit`, which queries the
    // `login` field via GraphQL and requires `read:org` that CI tokens usually lack.
    const num = existing.out.trim();
    const edited = await sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/pulls/${num}`, '-f', `title=${title}`, '-F', `body=@${bodyFile}`]);
    if (edited.code !== 0) { core.setFailed(`update PR body failed:\n${edited.out}`); return; }
    core.info(`Updated PR #${num}.`);
  } else {
    const created = await sh('gh', ['pr', 'create', '-R', repo, '--head', branch, '--base', ref, '--title', title, '--body-file', bodyFile]);
    if (created.code !== 0) { core.setFailed(`gh pr create failed:\n${created.out}`); return; }
    core.info(`Opened PR: ${created.out.trim()}`);
  }

  await core.summary.addRaw(body).write();
  core.setOutput('outcome', outcome);
  core.setOutput('branch', branch);

  // 5. Keep the job RED when unrecoverable drift remains (so Slack/ServiceApp alerting fires).
  const hasUnrecoverable = classified.some((c) => !c.recoverable && c.category !== 'ignorable');
  if (hasUnrecoverable) {
    core.setFailed('Reconciliation ran, but unrecoverable drift remains — see PR body.');
  }
})().catch((e) => core.setFailed(e.stack || String(e)));
