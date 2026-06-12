'use strict';
const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const path = require('path');
const { parseManifest } = require('./lib/parse-drift');
const { makeResolvers } = require('./lib/resolvers');
const { classify, versionConstraint } = require('./lib/classify');
const { upsertRequire } = require('./lib/composer');
const { decideOutcome } = require('./lib/outcome');
const { reportBody } = require('./lib/report');

function env(name, def = '') { return process.env[name] || def; }

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
  const runUrl = env('RUN_URL');
  const satispressUrl = env('SATISPRESS_URL');
  const satispressToken = env('SATISPRESS_TOKEN');
  const branch = `reconciliation-${ref}`;
  const composerPath = path.join(sourceDir, 'composer.json');

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    core.warning('No drift manifest available; nothing to reconcile.');
    return;
  }

  if (!ref) { core.setFailed('REF is required.'); return; }
  if (!repo) { core.setFailed('REPO is required.'); return; }

  // 1. Parse + classify.
  const items = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  const resolvers = makeResolvers(fetch, satispressUrl, satispressToken);
  const classified = await classify(items, { resolvers, treeRoot });
  const outcome = decideOutcome(classified);
  core.info(`Reconcile outcome: ${outcome} (${classified.length} classified items)`);

  if (outcome === 'noop') {
    await core.summary.addRaw('## Consistency reconciliation\n\nNo actionable drift classified (all manifest entries were noise/directories).').write();
    core.warning('No actionable drift classified.');
    return;
  }

  // 2. Apply composer changes for recoverable, composer-backed items.
  const hasComposer = fs.existsSync(composerPath);
  let composer = null;
  if (hasComposer) {
    try { composer = JSON.parse(fs.readFileSync(composerPath, 'utf8')); }
    catch (e) { throw new Error(`Failed to parse ${composerPath}: ${e.message}`); }
  }
  let composerChanged = false;
  const coreBumps = [];

  for (const c of classified) {
    if (!c.recoverable) continue;
    if (c.composerPackage && composer) {
      const r = upsertRequire(composer, c.composerPackage, versionConstraint(c.version));
      composer = r.composer;
      composerChanged = composerChanged || r.changed;
    } else if (c.category === 'wp-core') {
      coreBumps.push(c.key);
    }
  }
  if (composerChanged) {
    fs.writeFileSync(composerPath, JSON.stringify(composer, null, 4) + '\n');
    core.info('composer.json updated.');
  }
  if (coreBumps.length) {
    core.warning(`WordPress core drift detected (${coreBumps.length} files). Core bump must be handled by prepare-composer; flagged in PR body.`);
  }

  const willOpenPr = classified.some((c) => c.recoverable);
  const body = reportBody(classified, { ref, runUrl });

  // 3. If nothing recoverable, write a job summary and exit per outcome (no PR).
  if (!willOpenPr) {
    await core.summary.addRaw(body).write();
    if (outcome === 'ignorable-only') {
      core.warning('Drift is entirely ignorable. Recommend updating SSH_IGNORE_LIST; see job summary.');
    }
    core.setFailed(`Consistency drift not auto-recoverable (${outcome}).`);
    return;
  }

  // 4. Recreate reconciliation branch from latest {ref} and commit source changes.
  const cwd = sourceDir;
  await sh('git', ['config', 'user.name', 'saucal-ci'], { cwd });
  await sh('git', ['config', 'user.email', 'ci@saucal.com'], { cwd });
  const fetched = await sh('git', ['fetch', 'origin', ref], { cwd });
  if (fetched.code !== 0) { core.setFailed(`git fetch failed:\n${fetched.out}`); return; }
  const checkedOut = await sh('git', ['checkout', '-B', branch, `origin/${ref}`], { cwd });
  if (checkedOut.code !== 0) { core.setFailed(`git checkout failed:\n${checkedOut.out}`); return; }

  // Re-apply composer edit on top of fresh {ref} (checkout -B discarded the working-tree edit).
  if (composerChanged) {
    let fresh;
    try { fresh = JSON.parse(fs.readFileSync(path.join(cwd, 'composer.json'), 'utf8')); }
    catch (e) { throw new Error(`Failed to parse ${path.join(cwd, 'composer.json')}: ${e.message}`); }
    let merged = fresh;
    for (const c of classified) {
      if (c.recoverable && c.composerPackage) {
        merged = upsertRequire(merged, c.composerPackage, versionConstraint(c.version)).composer;
      }
    }
    fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify(merged, null, 4) + '\n');
    await sh('git', ['add', 'composer.json'], { cwd });
  }

  const { out: status } = await sh('git', ['status', '--porcelain'], { cwd });
  if (!status.trim()) {
    core.warning('No source-tree changes to commit (recoverable items needed no composer edit).');
    await core.summary.addRaw(body).write();
    core.setFailed(`Consistency drift could not be turned into a source change (${outcome}).`);
    return;
  }

  const committed = await sh('git', ['commit', '-m', `chore: reconcile server drift on ${ref}`], { cwd });
  if (committed.code !== 0) { core.setFailed(`git commit failed:\n${committed.out}`); return; }
  const push = await sh('git', ['push', '--force', 'origin', branch], { cwd });
  if (push.code !== 0) { core.setFailed(`git push failed:\n${push.out}`); return; }

  // 5. Upsert the PR via gh (GH_TOKEN is in env).
  const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-body-${ref}.md`);
  fs.writeFileSync(bodyFile, body);
  const title = `Reconcile server drift on ${ref}`;
  const existing = await sh('gh', ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
  if (existing.out.trim()) {
    const edited = await sh('gh', ['pr', 'edit', existing.out.trim(), '-R', repo, '--title', title, '--body-file', bodyFile]);
    if (edited.code !== 0) { core.setFailed(`gh pr edit failed:\n${edited.out}`); return; }
    core.info(`Updated PR #${existing.out.trim()}.`);
  } else {
    const created = await sh('gh', ['pr', 'create', '-R', repo, '--head', branch, '--base', ref, '--title', title, '--body-file', bodyFile]);
    if (created.code !== 0) { core.setFailed(`gh pr create failed:\n${created.out}`); return; }
    core.info(`Opened PR: ${created.out.trim()}`);
  }

  await core.summary.addRaw(body).write();
  core.setOutput('outcome', outcome);
  core.setOutput('branch', branch);

  // 6. Partial -> keep the job RED so existing Slack/ServiceApp alerting fires.
  if (outcome === 'partial') {
    core.setFailed('Reconciliation PR opened, but unrecoverable drift remains — see PR body.');
  }
})().catch((e) => core.setFailed(e.stack || String(e)));
