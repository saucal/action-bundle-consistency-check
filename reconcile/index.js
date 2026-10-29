'use strict';
const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const path = require('path');
const { makeResolvers } = require('./lib/resolvers');
const { reportBody } = require('./lib/report');
const { findMergedHeal, pendingOf, pendingOnMerge, lostInRunB } = require('./lib/merged-heal');
const { reconcileRun } = require('./lib/reconcile-run');
const { makeRunner } = require('./lib/runner');
const { branchSame } = require('./lib/branch-same');

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

/**
 * ServiceApp's POST /serviceapp/v1/vulns/match (Wordfence + CVE feed). Returns the per-item results,
 * or null when it can't answer (not configured, unreachable, error) — callers treat that as "unknown".
 */
async function vulnCheck(items) {
  const server = env('SAPP_SERVER');
  const key = env('SAPP_VULNS_KEY');
  const user = env('SAPP_APP_USER');
  const pass = env('SAPP_APP_PASS');
  if (!server || !(key || (user && pass))) { core.info('Vulnerability check not configured (SAPP_SERVER + SAPP_VULNS_KEY or app credentials).'); return null; }
  const headers = { 'Content-Type': 'application/json',
    Authorization: key ? `Bearer ${key}` : `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` };
  const results = [];
  try {
    for (let i = 0; i < items.length; i += 200) { // the endpoint takes at most 200 items per call
      // A bare host means https; a full URL (e.g. the e2e harness's http mock) is used as given.
      const base = /^https?:\/\//.test(server) ? server.replace(/\/$/, '') : `https://${server}`;
      const res = await fetch(`${base}/wp-json/serviceapp/v1/vulns/match`, {
        method: 'POST', headers, body: JSON.stringify({ items: items.slice(i, i + 200) }), signal: AbortSignal.timeout(30000),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || !Array.isArray(json.results)) { core.warning(`Vulnerability check failed (HTTP ${res.status}).`); return null; }
      results.push(...json.results);
    }
  } catch (e) {
    core.warning(`Vulnerability check unavailable: ${e.message}`);
    return null;
  }
  return results;
}

/**
 * Commits on {ref} not deployed yet: the last build's source ("Build changes from <sha>" at the built
 * repo's HEAD) and what changed between it and the tip. null when the tip is what was built, or the
 * build's source can't be read (then the heal works on the tip alone, as before).
 */
/** The source commit the built repo's last build names ('' when it names none). */
async function lastBuild(treeRoot) {
  const m = /Build changes from ([0-9a-f]{40})/.exec((await sh('git', ['-C', path.resolve(treeRoot), 'log', '-1', '--format=%s'], { silent: true })).out);
  return m ? m[1] : '';
}

async function undeployed(treeRoot, cwd, tip, ref) {
  const quiet = { cwd, silent: true };
  const since = await lastBuild(treeRoot);
  if (!since || since === tip) return null;
  if ((await sh('git', ['cat-file', '-e', `${since}^{commit}`], quiet)).code !== 0) await sh('git', ['fetch', '-q', '--no-tags', 'origin', since], quiet);
  // CI checkouts are shallow: deepen {ref} back to a day before the build's source, so the ancestry
  // check and the diff see the commits in between (bounded, unlike --unshallow).
  if ((await sh('git', ['rev-parse', '--is-shallow-repository'], quiet)).out.trim() === 'true') {
    const when = Number((await sh('git', ['show', '-s', '--format=%ct', since], quiet)).out.trim());
    if (when) await sh('git', ['fetch', '-q', '--no-tags', `--shallow-since=${when - 86400}`, 'origin', ref], quiet);
  }
  if ((await sh('git', ['merge-base', '--is-ancestor', since, tip], quiet)).code !== 0) {
    core.warning(`The last build's source ${since.slice(0, 7)} is not in ${tip.slice(0, 7)}'s history; healing on the tip only.`);
    return null;
  }
  const lockAt = async (rev) => {
    try { return new Map((JSON.parse((await sh('git', ['show', `${rev}:composer.lock`], quiet)).out).packages || []).map((p) => [p.name, p.version])); } catch { return new Map(); }
  };
  const coreAt = async (rev) => {
    try { return ((JSON.parse((await sh('git', ['show', `${rev}:composer.json`], quiet)).out).extra) || {})['wordpress-core'] || ''; } catch { return ''; }
  };
  const [a, b] = [await lockAt(since), await lockAt(tip)];
  return {
    since,
    packages: new Set([...a.keys(), ...b.keys()].filter((n) => a.get(n) !== b.get(n))),
    files: (await sh('git', ['diff', '--name-only', since, tip], quiet)).out.split('\n').filter(Boolean),
    core: (await coreAt(since)) !== (await coreAt(tip)),
    commits: Number((await sh('git', ['rev-list', '--count', `${since}..${tip}`], quiet)).out.trim()) || 0,
  };
}

/** Stage ONLY reconcile's outputs (not `git add -A`: Prepare injects build files that aren't source). */
async function stageOutputs(cwd, result, isTracked) {
  // Not .patches_applied: the local "patches already applied" marker. Committed, a fresh build
  // sees a matching hash and never reinstalls the patched packages, so patches don't apply.
  const OUTPUT_PATHS = ['composer.json', 'composer.lock', 'patches', 'patches.lock.json', '.gitignore'];
  // Tracked-but-gone counts too: a withdrawn last patch deletes patches/ and patches.lock.json.
  const toStage = OUTPUT_PATHS.filter((p) => fs.existsSync(path.join(cwd, p)) || isTracked(p));
  if (toStage.length) await sh('git', ['add', '-A', '--', ...toStage], { cwd });
  // Force-add adopted (vendored) component dirs — plugins/ is typically gitignored for
  // composer-managed installs, so a plain `git add` would skip the newly-vendored source.
  for (const root of (result.adoptedPaths || [])) await sh('git', ['add', '-f', '--', root], { cwd });
  // Committed code taken from the server, deletions included.
  if ((result.trackedPaths || []).length) await sh('git', ['add', '-A', '--', ...result.trackedPaths], { cwd });
  return (await sh('git', ['diff', '--cached', '--name-only'], { cwd })).out.split('\n').filter(Boolean);
}

/** Both runs scan the same server files: list each finding once. */
const uniqHits = (hits) => [...new Map(hits.map((h) => [JSON.stringify(h), h])).values()];

/**
 * Rewrite the open reconciliation PR's title and description. Returns its number, '' when no PR
 * is open, or false when the update failed (the step is failed).
 */
async function updatePr(repo, ref, branch, body) {
  const existing = await sh('gh', ['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'number', '-q', '.[0].number']);
  const num = existing.out.trim();
  if (!num) return '';
  const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-body-${ref}.md`);
  fs.writeFileSync(bodyFile, body);
  // The REST API (needs only `repo` scope), not `gh pr edit`: that queries `login` via GraphQL
  // and requires `read:org`, which CI tokens usually lack.
  const edited = await sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/pulls/${num}`, '-f', `title=Reconcile server drift on ${ref} [commit only]`, '-F', `body=@${bodyFile}`]);
  if (edited.code !== 0) { core.setFailed(`update PR body failed:\n${edited.out}`); return false; }
  core.info(`Updated PR #${num}.`);
  core.setOutput('pr', num);
  return num;
}

/** A git step the rest depends on: throw (fail closed) instead of carrying on with the wrong tree. */
async function must(args, cwd) {
  const r = await sh('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.out}`);
  return r.out.trim();
}

/** A heal no longer needed: close the open reconciliation PR, saying why, and delete its branch. */
async function closeStale(repo, branch, why) {
  const quiet = { silent: true };
  const pr = (await sh('gh', ['api', `repos/${repo}/pulls?head=${repo.split('/')[0]}:${branch}&state=open`, '-q', '.[0].number'], quiet)).out.trim();
  if (/^\d+$/.test(pr)) {
    await sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '-f', `body=Closed by consistency self-heal: ${why}`], quiet);
    await sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/pulls/${pr}`, '-f', 'state=closed'], quiet);
    core.info(`Closed stale PR #${pr}: ${why}`);
  }
  if ((await sh('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${branch}`], quiet)).code === 0) core.info(`Deleted ${branch}.`);
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
  if (env('CLEANUP_ONLY')) {
    await closeStale(repo, branch, 'the consistency check is green — the server matches the deployed build, so this reconciliation is no longer needed.');
    return;
  }
  // Composer SatisPress auth is configured by the action step (composer config --global --auth)
  // before this script runs, so every composer subprocess here reads it from auth.json.

  // Server's WP core version, recorded by prepare-composer's core hook during the check.
  const coreFile = path.join(process.env.RUNNER_TEMP || '/tmp', 'core-version-remote');
  const coreVersionRemote = fs.existsSync(coreFile) ? fs.readFileSync(coreFile, 'utf8').trim() : '';
  const coreManagedByHost = fs.existsSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'core-managed-by-host'));
  const hasManifest = manifestPath && fs.existsSync(manifestPath);
  if (!hasManifest && !coreVersionRemote) {
    core.warning('No drift manifest available; nothing to reconcile.');
    return;
  }
  if (!ref) { core.setFailed('REF is required.'); return; }
  if (!repo) { core.setFailed('REPO is required.'); return; }

  const manifestText = hasManifest ? fs.readFileSync(manifestPath, 'utf8') : '';
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
  // The base this branch was cut from — the convergence gate merges only while origin/{ref} is still here.
  const baseSha = (await sh('git', ['rev-parse', `origin/${ref}`], { cwd })).out.trim();
  core.setOutput('base-sha', baseSha);
  const pending = await undeployed(treeRoot, cwd, baseSha, ref);

  // What the repo commits itself: those paths are healed by copying the server's version, never
  // looked up in a registry. A directory counts if it holds tracked files.
  // Read per checkout: the heal on the deployed commit needs that commit's list, not the tip's.
  const trackedIn = async () => {
    const ls = await sh('git', ['ls-files', '-z'], { cwd, silent: true });
    const files = new Set(ls.out.split('\0').filter(Boolean));
    const dirs = new Set();
    for (const f of files) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
    return (p) => files.has(p) || dirs.has(p);
  };
  let isTracked = await trackedIn();

  // 2. Classify + apply (composer add/bump + patches) via the orchestrator core.
  // SatisPress resolution goes through composer itself (`composer show`), reusing the SAME
  // auth.json action-composer-auth already configured earlier in this job — no separate
  // credential handling for the resolver.
  const runner = makeRunner();
  const resolvers = makeResolvers({ fetch, runner, cwd });
  // SAUCAL_CONSISTENCY_RECONCILE_MERGE=0: a human merges, so one PR carries everything (no split).
  const autoMergeOn = env('RECONCILE_MERGE', '1') !== '0';
  let result;
  let tipResult = null; // undeployed commits: run A (the tip) — `result` is then run B (the deployed commit)
  let tipTree = '';
  let merged = null; // the tip already carries every repo change: { sha } of the merged heal ('' if none)
  try {
    const runOnce = (only, p = pending) => reconcileRun({ sourceDir, treeRoot, manifestText, contentDiffText, resolvers, runner, adopt, coreVersionRemote, coreManagedByHost, isTracked, vulnCheck, only, pending: p || undefined });
    const supersededKeys = (r) => r.classified.filter((c) => c.category === 'superseded').map((c) => c.key);
    result = await runOnce();
    // Mixed heal: merge the part that needs no review now; the rest is deferred, and the next run
    // (which then sees only that) opens a PR for it. Start again from the clean branch tip, undoing
    // only what this run wrote (tracked files, the patch dir, copied paths) — not what Prepare injected.
    if (autoMergeOn && !result.autoMerge.ok && result.autoMerge.eligible.length) {
      core.info(`Mixed heal: merging ${result.autoMerge.eligible.join(', ')} now; the rest waits for the next run's review PR.`);
      await must(['reset', '-q', '--hard', `origin/${ref}`], cwd);
      // -x within these paths only: adopted dirs are usually gitignored (plugins/).
      await must(['clean', '-fdqx', '--', 'patches', 'patches.lock.json', ...(result.trackedPaths || []), ...(result.adoptedPaths || [])], cwd);
      result = await runOnce(new Set([...result.autoMerge.eligible, ...supersededKeys(result)]));
    }
    // Undeployed commits: the same heal (plus the superseded items, at the server's version) on the
    // deployed commit. Its build is what the server runs now — verify checks it, and the built repo
    // gets it — while the tip's heal is what merges into {ref}.
    // Every PR takes this shape, held ones too: merged by hand, a one-commit PR would record the tip
    // (undeployed commits included) as what the server runs.
    if (pending) {
      core.info(`${ref} has ${pending.commits} commit(s) not deployed yet (last build: ${pending.since.slice(0, 7)}): the heal is built on that commit and merged next to them.`);
      tipResult = result;
      const tipStaged = await stageOutputs(cwd, result, isTracked);
      if (tipStaged.length) {
        // F's tree merges unattended without being built: at least prove its lock is valid.
        const valid = await runner.composer(['validate', '--no-check-all', '--no-check-publish', '--check-lock'], { cwd });
        if (valid.code !== 0) throw new Error(`the heal on the tip leaves an invalid composer.json/lock:\n${valid.stdout || ''}${valid.stderr || ''}`);
        await must(['commit', '-q', '-m', `chore: reconcile server drift on ${ref}`], cwd);
        tipTree = await must(['rev-parse', 'HEAD^{tree}'], cwd);
      } else {
        // Nothing to change on the tip: a heal merged before whose built-repo record never landed, or
        // fixes committed by hand. No PR or commit for that: the check's status and summary say it.
        merged = { sha: findMergedHeal((await sh('git', ['log', '--no-merges', '--format=%H%x09%s', `${pending.since}..${baseSha}`], { cwd, silent: true })).out, ref) };
      }
      if (!merged) {
        await must(['reset', '-q', '--hard'], cwd);
        await must(['clean', '-fdqx', '--', 'patches', 'patches.lock.json', ...(result.trackedPaths || []), ...(result.adoptedPaths || [])], cwd);
        await must(['checkout', '-q', '-B', `${branch}-build`, pending.since], cwd);
        // plugins/ is gitignored, so the checkout keeps run A's patched installs: reinstall them as the
        // deployed commit has them, or run B diffs the server against run A's copy and writes no patch.
        for (const c of tipResult.classified.filter((x) => x.patchFile && x.composerPackage)) {
          const re = await runner.composer(['reinstall', c.composerPackage, '--no-progress'], { cwd });
          if (re.code !== 0) throw new Error(`composer reinstall ${c.composerPackage} failed:\n${re.stdout || ''}${re.stderr || ''}`);
        }
        isTracked = await trackedIn();
        const superseded = new Set(supersededKeys(result));
        result = await reconcileRun({ sourceDir, treeRoot, manifestText, contentDiffText, resolvers, runner, adopt, coreVersionRemote, coreManagedByHost, isTracked, vulnCheck,
          // What run A applied (a mixed heal's rerun defers the rest); equals autoMerge.eligible when it merges unattended.
          only: new Set([...tipResult.classified.filter((c) => c.recoverable).map((c) => c.key), ...superseded]), supersededKeys: superseded });
      }
    }
  } catch (e) {
    core.setFailed(`reconcile-run failed: ${e.stack || e}`);
    return;
  }
  // Run B is what gets built and recorded: an item only run A recovered would vanish from the parity
  // commit while the PR shows it as made. Fail closed: no push, no PR.
  const lost = tipResult && !merged ? lostInRunB(tipResult.classified, result.classified) : [];
  if (lost.length) {
    await core.summary.addRaw([`## Consistency reconciliation`, '',
      `The heal on the last deployed commit (\`${pending.since.slice(0, 7)}\`) could not make ${lost.length} change(s) the heal on \`${ref}\` makes, so nothing was pushed and no PR was opened or updated:`, '',
      ...lost.map((c) => `- \`${c.composerPackage || c.key}\` — ${c.remediation || c.category}${c.composerOutput ? `\n\n  \`\`\`\n  ${String(c.composerOutput).trim().replace(/\n/g, '\n  ')}\n  \`\`\`` : ''}`),
      '', `From the [consistency check run](${runUrl}).`].join('\n')).write();
    core.setFailed(`The heal on the deployed commit lost ${lost.map((c) => c.key).join(', ')}: see the job summary. Nothing pushed.`);
    return;
  }
  if (merged) {
    const { sha } = merged;
    await core.summary.addRaw(reportBody(result.classified, { ref, runUrl, already: sha || true })).write();
    await closeStale(repo, branch, `\`${ref}\` already carries every change it proposed${sha ? ` (${sha.slice(0, 7)})` : ''}.`);
    if (sha) {
      // The verify job builds the heal (zero-change dry run, its own pending paths ignored) and records it in the built repo.
      core.setOutput('head-sha', baseSha);
      core.setOutput('build-sha', sha);
      core.setOutput('pending-paths', pendingOf((await sh('git', ['show', '-s', '--format=%B', sha], { cwd, silent: true })).out));
      core.notice(`${ref} already has the server's state in ${sha.slice(0, 7)}, merged but not recorded in the built repo: recording it. No PR, nothing deployed.`);
    } else if (result.classified.some((c) => c.recoverable)) {
      core.notice(`${ref} already carries every repo change, in commits not deployed yet: the next Deploy ships them. No PR.`);
    }
    const open = result.classified.filter((c) => !c.recoverable && c.category !== 'ignorable').length;
    if (open) core.setFailed(`${open} item(s) still need a decision: see the job summary.`);
    return;
  }

  // With undeployed commits the PR shows the tip's heal (run A); merging, verify and the built repo
  // follow the heal on the deployed commit (run B).
  const { classified, applied, verification } = tipResult || result;
  // Both runs' security findings: run B assesses patches for superseded items run A never made.
  const security = tipResult
    ? { critical: uniqHits([...tipResult.security.critical, ...result.security.critical]), warn: uniqHits([...tipResult.security.warn, ...result.security.warn]) }
    : result.security;
  const { outcome } = result; // what gets built: run B when there are undeployed commits
  const autoMerge = tipResult ? { ...result.autoMerge, reasons: [...new Set([...tipResult.autoMerge.reasons, ...result.autoMerge.reasons])] } : result.autoMerge;
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
  // Run B's too: it re-heals superseded items as fresh requires.
  const unavailable = new Set([...classified, ...(tipResult ? result.classified : [])]
    .filter((c) => c.category === 'version-unavailable' && c.composerOutput)
    .map((c) => `composer could not install ${c.composerPackage}:\n${c.composerOutput}`));
  for (const w of unavailable) core.warning(w);

  let body = reportBody(classified, { ref, runUrl });
  if (tipResult) {
    body = `**Undeployed commits:** \`${ref}\` has ${pending.commits} commit(s) not deployed yet (since \`${pending.since.slice(0, 7)}\`). ` +
      `This PR makes the repo changes on that commit first (the server's state, which the built repo records on merge), then merges those ${pending.commits} on top: they stay undeployed until the next Deploy, which then goes through.\n\n` + body;
  }

  // Compromise signals in server-derived content: say so first, and tell the workflow (no merge,
  // Slack ping). The PR still opens/updates so a human sees exactly what was found.
  const crit = (security && security.critical) || [];
  const warn = (security && security.warn) || [];
  core.setOutput('suspicious', crit.length ? 'true' : 'false');
  if (crit.length || warn.length) {
    const line = (h) => `- \`${h.file}:${h.line}\` — ${h.rule}`;
    const sec = [];
    if (crit.length) {
      sec.push('## 🚨 Security review required — not auto-merged', '',
        'Content taken from the server (with no registry version behind it) carries signals of compromised code. ' +
        'Treat this as a possible security incident: review these files on the server before merging anything.', '',
        ...crit.map(line), '');
      core.setOutput('security-summary', [...new Set(crit.map((h) => `${h.file} (${h.rule})`))].slice(0, 10).join(', '));
      core.error(`Compromise signals in server-derived content: ${crit.length} critical finding(s). Not merging.`);
    }
    if (warn.length) sec.push('<details><summary>Reviewer notes: ' + warn.length + ' lower-severity signal(s)</summary>', '', ...warn.map(line), '', '</details>', '');
    body = sec.join('\n') + '\n' + body;
  }

  core.setOutput('auto-merge', autoMergeOn && autoMerge && autoMerge.ok ? 'true' : 'false');
  // Paths the checks must not count this time (deferred, flagged or junk drift), as anchored rsync rules.
  // Auto-merge off: what this run leaves alone (the recovery path's verify still runs then).
  core.setOutput('pending-paths', ((autoMerge && (autoMergeOn ? autoMerge.pending : autoMerge.open)) || []).join('\n'));
  // Drift the PR leaves alone is listed once, under "Repo changes this PR can't make".
  // A "needs a human" reason is dropped only when the body lists every item it names, so a hold always shows why.
  const cantMake = new Set(classified.filter((c) => !c.recoverable && c.category !== 'ignorable').map((c) => `${c.key} (${c.category})`));
  const reasonLines = ((autoMerge && autoMerge.reasons) || [])
    .filter((r) => !r.startsWith('needs a human: ') || !r.slice('needs a human: '.length).split(', ').every((k) => cantMake.has(k))).map((r) => `- ${r}`).join('\n');
  body = (!autoMergeOn
    ? `**Auto-merge:** off for this repo (\`SAUCAL_CONSISTENCY_RECONCILE_MERGE=0\`) — review and merge by hand. Merging only changes the repo: nothing is deployed.${reasonLines ? `\n\nNeeds attention:\n${reasonLines}` : ''}\n\n`
    : autoMerge && autoMerge.ok
      ? '**Auto-merge:** eligible — merged only if a build of this branch reproduces the server exactly.\n\n'
      : `**Auto-merge:** held for a human — ${reasonLines ? `\n${reasonLines}` : "see “Repo changes this PR can't make”."}\n\n`) + body;

  if (outcome === 'noop') {
    await core.summary.addRaw('## Consistency reconciliation\n\nNo actionable drift classified (all manifest entries were noise/directories).').write();
    core.warning('No actionable drift classified.');
    return;
  }

  // 3. Stage and commit only reconcile's outputs.
  const staged = await stageOutputs(cwd, result, isTracked);
  if (!staged.length) {
    // No PR, so no PR wording (a withdrawn suspicious heal keeps its PR, and its body, below).
    const suspicious = classified.some((c) => c.category === 'suspicious');
    await core.summary.addRaw(suspicious ? body : reportBody(classified, { ref, runUrl, already: true })).write();
    if (outcome === 'ignorable-only') {
      core.warning('Drift is entirely ignorable. Recommend updating SSH_IGNORE_LIST; see job summary.');
    } else {
      // Source already carries every recoverable fix (e.g. a heal whose built push failed last
      // run): let the gate rebuild {ref} as-is — if that converges it only commits the built repo.
      // Not when the built repo already records {ref}'s tip: that rebuild would record nothing.
      if ((await lastBuild(treeRoot)) !== baseSha) core.setOutput('head-sha', baseSha);
    }
    // A withdrawn (suspicious) heal also leaves nothing to commit: keep its PR as the evidence.
    if (suspicious) {
      await updatePr(repo, ref, branch, body); // the open PR says what was found now
    } else {
      await closeStale(repo, branch, 'the repo already carries every change this reconciliation proposed (nothing left to commit).');
    }
    core.setFailed(`Consistency drift produced no committable source change (${outcome}).`);
    return;
  }

  // With undeployed commits this is R, the parity commit: [commit only] is what happens to it (built
  // after a zero-change dry run, never rsynced).
  // The merge fast-forwards {ref} to this commit (or, with undeployed commits, to F on top of it), so
  // its message is what the push-triggered Deploy reads: [commit only] = build it, require a
  // zero-change dry run, commit the build, never rsync; Self-heal-pending = paths left for review.
  // Merged by hand, the PR carries everything it applies: only what it leaves alone is pending.
  const pendingLines = ((autoMerge && pendingOnMerge(autoMergeOn, autoMerge)) || []).map((p) => `Self-heal-pending: ${p}`);
  const committed = await sh('git', ['commit', '-m', tipResult
    ? [`Reconcile server drift on ${ref} [commit only]`, '', `Parity with the server: the last deployed commit (${pending.since.slice(0, 7)}) plus the server's changes.`,
      ...(pendingLines.length ? ['', ...pendingLines] : [])].join('\n')
    : [`Reconcile server drift on ${ref} [commit only]`, '', 'Brings the repo in line with the server; verified to reproduce it before merging.',
      ...(pendingLines.length ? ['', ...pendingLines] : [])].join('\n')], { cwd });
  if (committed.code !== 0) { core.setFailed(`git commit failed:\n${committed.out}`); return; }
  let headSha = (await sh('git', ['rev-parse', 'HEAD'], { cwd })).out.trim();
  let buildSha = '';
  if (tipResult) {
    // Parity first, then the undeployed work: R (this commit) = the deployed commit + the server's
    // drift; F = R with the undeployed commits applied after it (1st parent R, 2nd the tip), so {ref}
    // fast-forwards to F and `git log --first-parent` reads F, R, deployed. F was never deployed, so
    // it says [skip deploy]; the workflow builds R for the built repo itself, after the fast-forward.
    buildSha = headSha;
    const merge = await sh('git', ['commit-tree', tipTree, '-p', buildSha, '-p', baseSha, '-m',
      [`Apply the ${pending.commits} commit(s) not deployed yet after parity [skip deploy]`, '',
        `Parity with the server is ${buildSha.slice(0, 7)}; these changes are still not deployed — the next Deploy of ${ref} ships them.`].join('\n')], { cwd });
    if (merge.code !== 0) { core.setFailed(`git commit-tree failed:\n${merge.out}`); return; }
    headSha = merge.out.trim();
    await sh('git', ['checkout', '-q', '-B', branch, headSha], { cwd });
  }
  // Skip the force-push when the open branch already holds this exact result on this exact base:
  // a new commit every run would dismiss any review on the PR (stale-review ruleset).
  const remote = await sh('git', ['fetch', 'origin', branch], { cwd });
  const rev = async (r) => (await sh('git', ['rev-parse', r], { cwd, silent: true })).out.trim();
  const msg = async (r) => (await sh('git', ['log', '-1', '--format=%B', r], { cwd, silent: true })).out;
  const same = remote.code === 0 && await branchSame({ rev, msg, baseSha, buildSha, since: buildSha && pending.since });
  if (same) {
    headSha = await rev('FETCH_HEAD');
    if (buildSha) buildSha = await rev('FETCH_HEAD^1');
    core.info(`${branch} already holds this reconciliation on ${baseSha.slice(0, 7)}; not pushing.`);
  } else {
    const push = await sh('git', ['push', '--force', 'origin', branch], { cwd });
    if (push.code !== 0) { core.setFailed(`git push failed:\n${push.out}`); return; }
  }
  core.setOutput('head-sha', headSha);
  core.setOutput('build-sha', buildSha);

  // 4. Upsert the PR via gh (GH_TOKEN is in env); the description is rewritten every run.
  const updated = await updatePr(repo, ref, branch, body);
  if (updated === false) return;
  if (!updated) {
    const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-body-${ref}.md`);
    fs.writeFileSync(bodyFile, body);
    // [commit only] in the title too: a squash merge's commit takes it, so a hand merge never deploys.
    const title = `Reconcile server drift on ${ref} [commit only]`;
    const created = await sh('gh', ['pr', 'create', '-R', repo, '--head', branch, '--base', ref, '--title', title, '--body-file', bodyFile]);
    if (created.code !== 0) { core.setFailed(`gh pr create failed:\n${created.out}`); return; }
    core.info(`Opened PR: ${created.out.trim()}`);
    core.setOutput('pr', (created.out.match(/\/pull\/(\d+)/) || [])[1] || '');
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
