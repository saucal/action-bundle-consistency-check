'use strict';
const core = require('@actions/core');
const exec = require('@actions/exec');
const fs = require('fs');
const path = require('path');
const { makeResolvers } = require('./lib/resolvers');
const { reportBody, heldNote, undeployedNote, healCommitLine, noCommitFailure, remaining } = require('./lib/report');
const { prState, stateMarker, readState, changeComment } = require('./lib/pr-trace');
const { findMergedHeal, pendingOf, pendingOnMerge, lostInRunB, combineRuns } = require('./lib/merged-heal');
const { reconcileRun } = require('./lib/reconcile-run');
const { makeRunner } = require('./lib/runner');
const { branchSame } = require('./lib/branch-same');
const { undeployed, recorded } = require('./lib/undeployed');
const { stageOutputs, keepRefused } = require('./lib/stage');
const { splitHeal } = require('./lib/split-heal');
const { endRun, isRecovery } = require('./lib/outcome');
const { tipBranchOf, TIP_LABEL, tipTitle, engineerLogins, tipNote, joinedComment, recoveredNote, tipPrVerdict, recoverable, parseTipPrs, keptReplacesNote } = require('./lib/undeployed-pr');
const { isHealSubject, healOf, materializeTip, tipHead } = require('./lib/tip-head');

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

/** The source commit the built repo's last build names ('' when it names none). */
async function lastBuild(treeRoot) {
  const m = /Build changes from ([0-9a-f]{40})/.exec((await sh('git', ['-C', path.resolve(treeRoot), 'log', '-1', '--format=%s'], { silent: true })).out);
  return m ? m[1] : '';
}

/**
 * Rewrite the open reconciliation PR's title and description, commenting when what it carries or
 * its auto-merge verdict changed. Returns its number, '' when no PR is open, or false when the
 * update failed (the step is failed).
 */
async function updatePr(repo, ref, branch, body, runUrl, title = `Reconcile server drift on ${ref} [commit only]`, traceOverride = '') {
  const existing = await sh('gh', ['api', `repos/${repo}/pulls?head=${repo.split('/')[0]}:${branch}&state=open`, '-q', '.[0] // empty | {number, body}'], { silent: true });
  let open = null;
  try { open = existing.out.trim() ? JSON.parse(existing.out) : null; } catch { core.setFailed(`listing the open PR failed:\n${existing.out}`); return false; }
  if (!open) return '';
  const num = String(open.number);
  const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-body-${ref}.md`);
  fs.writeFileSync(bodyFile, body);
  // The REST API (needs only `repo` scope), not `gh pr edit`: that queries `login` via GraphQL
  // and requires `read:org`, which CI tokens usually lack.
  const edited = await sh('gh', ['api', '-X', 'PATCH', `repos/${repo}/pulls/${num}`, '-f', `title=${title}`, '-F', `body=@${bodyFile}`], { silent: true }); // the response is the whole PR as JSON
  if (edited.code !== 0) { core.setFailed(`update PR body failed:\n${edited.out}`); return false; }
  core.info(`Updated PR #${num}.`);
  const trace = traceOverride || changeComment(readState(open.body), readState(body), runUrl);
  if (trace && (await sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${num}/comments`, '-f', `body=${trace}`], { silent: true })).code !== 0) {
    core.warning(`Could not comment on PR #${num} about what changed.`);
  }
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

/**
 * Does {repo}'s commit b contain commit a (GitHub's compare)? null when the API can't say (an error, an
 * unknown sha): callers then leave the PR and its branch alone.
 */
async function contains(repo, a, b) {
  const r = await sh('gh', ['api', `repos/${repo}/compare/${a}...${b}`, '-q', '.status'], { silent: true });
  const st = r.code === 0 ? r.out.trim() : '';
  return /^(ahead|identical)$/.test(st) ? true : /^(behind|diverged)$/.test(st) ? false : null;
}

/** The heal a tip PR's head carries (see lib/tip-head): the head itself, or an FT head's 1st parent. */
async function healOfHead(repo, head) {
  const r = await sh('gh', ['api', `repos/${repo}/commits/${head}`, '-q', '[(.commit.message | split("\\n")[0]), (.parents[0].sha // "")] | @tsv'], { silent: true });
  const [subject, parent0] = r.out.trim().split('\t');
  return healOf(head, subject, parent0);
}

/** The undeployed-tip PRs from tipBranch in a state: [{ number, head, rm, body, merged }], newest first. */
async function tipPrs(repo, tipBranch, state) {
  const r = await sh('gh', ['api', `repos/${repo}/pulls?head=${repo.split('/')[0]}:${tipBranch}&state=${state}&per_page=20`,
    '-q', '[.[] | {number, head: .head.sha, body, merged: (.merged_at != null)}] | sort_by(-.number)'], { silent: true });
  // A failed listing is not "no PR": it throws (the step fails), like updatePr, instead of healing as if none waited.
  const prs = parseTipPrs(r, `${state} PRs from ${tipBranch}`);
  for (const pr of prs) { pr.number = String(pr.number); pr.rm = await healOfHead(repo, pr.head); }
  return prs;
}

/**
 * The undeployed-tip PR is needed while the built repo records a heal it carries. Once the record names
 * something its head doesn't contain (a forced Deploy, a newer record), merging it would bring a stale
 * heal back: close it. Also when none of its heals was ever recorded and the record is on {ref} (its
 * verify failed, or the drift went away): the next heal is rebuilt from the record in a fresh PR.
 * Its branch is what keeps RM and R reachable, so it is deleted only then.
 * @returns the PR still waiting ({ number, head, rm, body }), or null
 */
async function settleTipPr(repo, ref, tipBranch, record) {
  const [pr] = await tipPrs(repo, tipBranch, 'open');
  if (!pr) return null;
  const verdict = record ? tipPrVerdict(pr, record, { inHead: await contains(repo, record, pr.head), inRef: await contains(repo, record, ref) }) : 'keep';
  if (verdict === 'stale') {
    await closeStale(repo, tipBranch, `the built repo no longer records a heal this PR carries (it records ${record.slice(0, 7)}), so merging this would bring back a stale heal.`);
    return null;
  }
  if (verdict === 'unrecorded') {
    await closeStale(repo, tipBranch, `its heal ${pr.rm.slice(0, 7)} was never recorded as deployed (the built repo still records ${record.slice(0, 7)}), so the next heal starts again from there.`);
    return null;
  }
  return pr;
}

/**
 * Owner decision (2026-11-04): an engineers' PR closed without merging must not leave the heal stuck.
 * When the newest such PR still carries the record and {ref} doesn't contain it, open a fresh PR from
 * the same branch (a closed PR is never reopened or repurposed), linking the closed one, routed and
 * announced again. The branch is recreated at the closed head if it was deleted.
 * @returns the fresh PR ({ number, head, rm, body, recovered }), or null
 */
async function recoverTipPr(repo, ref, tipBranch, record) {
  if (!record) return null;
  const closed = (await tipPrs(repo, tipBranch, 'closed'))[0];
  if (!recoverable(closed, record, closed ? { inHead: await contains(repo, record, closed.head), inRef: await contains(repo, record, ref) } : {})) return null;
  const quiet = { silent: true };
  const at = (await sh('gh', ['api', `repos/${repo}/git/ref/heads/${tipBranch}`, '-q', '.object.sha'], quiet)).out.trim();
  let head = closed.head;
  const kept = /^[0-9a-f]{40}$/.test(at) ? await contains(repo, closed.head, at) : false;
  if (kept === null) { core.warning(`Could not compare ${tipBranch} with closed PR #${closed.number}'s head; not recovering it this run.`); return null; }
  if (kept) head = at;
  else if (/^[0-9a-f]{40}$/.test(at)) { core.warning(`${tipBranch} moved off closed PR #${closed.number}'s head; not recovering it.`); return null; }
  else if ((await sh('gh', ['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${tipBranch}`, '-f', `sha=${closed.head}`], quiet)).code !== 0) {
    core.warning(`Could not recreate ${tipBranch} at closed PR #${closed.number}'s head; not recovering it.`); return null;
  }
  const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-recovered-${ref}.md`);
  fs.writeFileSync(bodyFile, recoveredNote(ref, closed.number, record) + String(closed.body || ''));
  const created = await sh('gh', ['pr', 'create', '-R', repo, '--head', tipBranch, '--base', ref, '--title', tipTitle(ref), '--body-file', bodyFile], quiet);
  const num = (created.out.match(/\/pull\/(\d+)/) || [])[1];
  if (created.code !== 0 || !num) { core.warning(`Could not open a fresh PR for closed #${closed.number}:\n${created.out}`); return null; }
  await sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${closed.number}/comments`, '-f', `body=Closed without merging, but the built repo still records its heal ${record.slice(0, 7)}: the self-heal opened #${num} in its place (a closed PR is never reopened).`], quiet);
  let logins = (await sh('gh', ['api', `repos/${repo}/issues/${closed.number}`, '-q', '.assignees[].login'], quiet)).out.split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9-]+$/.test(l));
  // Nobody assigned on the closed PR: the undeployed commits' authors, as for a new PR (record...ref = U's commits since D).
  if (!logins.length) {
    logins = engineerLogins((await sh('gh', ['api', `repos/${repo}/compare/${record}...${ref}`, '-q', '.commits[] | (.author.login // empty), (.committer.login // empty)'], quiet)).out,
      (await sh('gh', ['api', 'user', '-q', '.login'], quiet)).out.trim());
  }
  await routeTipPr(repo, num, logins);
  core.warning(`Engineers' PR #${closed.number} was closed without merging while ${ref} still lacks the recorded heal ${record.slice(0, 7)}: opened #${num} in its place.`);
  core.setOutput('undeployed-pr', num);
  core.setOutput('undeployed-pr-recovered', closed.number);
  core.setOutput('engineers', logins.map((l) => `@${l}`).join(', '));
  // Its newest heal, which may be newer than the record (a heal that joined and was never verified): the
  // drift path then refuses, as for an open PR in that state.
  return { number: num, head, rm: await healOfHead(repo, head), body: fs.readFileSync(bodyFile, 'utf8'), recovered: closed.number };
}

/** Route the undeployed-tip PR to the engineers: label, assignees, review requests. Never fails the run. */
async function routeTipPr(repo, num, logins) {
  const quiet = { silent: true };
  // 422 when the label exists already.
  await sh('gh', ['api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${TIP_LABEL}`, '-f', 'color=D93F0B', '-f', 'description=Self-heal: undeployed commits to merge on top of a heal'], quiet);
  if ((await sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${num}/labels`, '-f', `labels[]=${TIP_LABEL}`], quiet)).code !== 0) core.warning(`Could not label PR #${num} ${TIP_LABEL}.`);
  if (!logins.length) { core.warning(`PR #${num}: no GitHub user found for the undeployed commits; it is unassigned.`); return; }
  const each = (k) => logins.flatMap((l) => ['-f', `${k}[]=${l}`]);
  if ((await sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${num}/assignees`, ...each('assignees')], quiet)).code !== 0) core.warning(`Could not assign PR #${num} to ${logins.join(', ')}.`);
  if ((await sh('gh', ['api', '-X', 'POST', `repos/${repo}/pulls/${num}/requested_reviewers`, ...each('reviewers')], quiet)).code !== 0) core.warning(`Could not request a review of PR #${num} from ${logins.join(', ')} (not collaborators?).`);
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
  const tipBranch = tipBranchOf(ref);
  if (env('CLEANUP_ONLY')) {
    await closeStale(repo, branch, 'the consistency check is green — the server matches the deployed build, so this reconciliation is no longer needed.');
    // Green is what an open undeployed-tip PR expects (the server runs its recorded heal): keep it unless
    // stale. A closed one whose heal is still the record gets a fresh PR (and the loud alert again).
    const record = await lastBuild(treeRoot);
    if (!(await settleTipPr(repo, ref, tipBranch, record))) await recoverTipPr(repo, ref, tipBranch, record);
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
  // An engineers' PR still waiting (or closed without merging, recovered as a fresh one): the record is
  // its newest heal, which {ref} doesn't carry yet. New drift joins that PR in place (owner, 2026-11-04):
  // the heal is built on the record and the heal on the tip on what merging the PR would make, so the
  // PR keeps every heal; its head only gains commits. tipStart is where the heal on the tip starts.
  const record = await lastBuild(treeRoot);
  const waiting = (await settleTipPr(repo, ref, tipBranch, record)) || await recoverTipPr(repo, ref, tipBranch, record);
  const refuse = async (why) => {
    await sh('gh', ['api', '-X', 'POST', `repos/${repo}/issues/${waiting.number}/comments`, '-f', `body=${why} From the [consistency check run](${runUrl}).`], { silent: true });
    core.setOutput('undeployed-pr', waiting.number);
    core.setFailed(`${why} Merge PR #${waiting.number}, then the next check heals the rest.`);
  };
  let tipStart = `origin/${ref}`;
  let inPlace = null;
  if (waiting) {
    if (waiting.rm !== record) {
      await refuse(`New server drift on \`${ref}\` while PR #${waiting.number} waits: its newest heal ${waiting.rm.slice(0, 7)} is not recorded as deployed yet (the built repo records ${record.slice(0, 7)}), so no heal joins it.`);
      return;
    }
    const got = await sh('git', ['fetch', 'origin', `+refs/heads/${tipBranch}:refs/remotes/origin/${tipBranch}`], { cwd });
    const at = got.code === 0 ? (await sh('git', ['rev-parse', `origin/${tipBranch}`], { cwd, silent: true })).out.trim() : '';
    const git = (...args) => sh('git', args, { cwd, silent: true });
    // The record is a heal (RM, RM2...) newer than the deployed commit D it stands on: deepen a shallow
    // {ref} back to D (undeployed() deepens to the record's date only), so the merge below and the
    // undeployed commits see their merge base.
    let d = record;
    for (let i = 0; i < 50 && isHealSubject((await git('log', '-1', '--format=%s', d)).out); i++) d = (await git('rev-parse', `${d}^1`)).out.trim();
    const when = Number((await git('show', '-s', '--format=%ct', d)).out.trim());
    if (when && (await git('rev-parse', '--is-shallow-repository')).out.trim() === 'true') await git('fetch', '-q', '--no-tags', `--shallow-since=${when - 86400}`, 'origin', ref);
    const t = at === waiting.head ? await materializeTip(git, baseSha, at, `Merge PR #${waiting.number} into ${ref} (local only: what merging it makes)`) : null;
    if (!t) {
      await refuse(`New server drift on \`${ref}\` while PR #${waiting.number} waits: \`${ref}\` and the PR no longer merge cleanly${at === waiting.head ? '' : ' (or its branch moved)'}, so the drift can't join it. Resolve the PR's conflicts with \`${ref}\`.`);
      return;
    }
    await must(['checkout', '-q', '-B', branch, t], cwd);
    tipStart = t;
    inPlace = waiting;
    core.info(`New drift joins PR #${waiting.number} in place: the heal is built on the recorded heal ${record.slice(0, 7)}, the heal on the tip on ${t.slice(0, 7)} (${ref} merged with the PR).`);
  }
  // In place, the tip is what merging the PR makes: it contains the record, so the undeployed commits
  // are counted from the record's merge base with {ref}.
  const pending = await undeployed(record, cwd, inPlace ? tipStart : baseSha, ref, core.warning);
  if (inPlace && !pending) { await refuse(`New server drift on \`${ref}\` while PR #${inPlace.number} waits, but its undeployed commits could not be read, so the drift can't join it.`); return; }

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
    // Mixed heal (see splitHeal): merge the part that needs no review now, defer the rest — or, when the
    // tip already carries that part, heal everything in one held PR. Start again from the clean branch
    // tip, undoing only what a run wrote (tracked files, the patch dir, copied paths) — not what Prepare injected.
    if (autoMergeOn && !result.autoMerge.ok && result.autoMerge.eligible.length) {
      // Ask git first: an item it refuses is in no commit, so no later run can open a PR for it either.
      const before = result.classified.filter((c) => c.recoverable);
      await stageOutputs(cwd, result, isTracked, (args) => sh('git', args, { cwd }));
      const refused = before.filter((c) => !c.recoverable);
      const refusedNotes = result.security.warn.filter((h) => h.notInPr); // the rerun scans only what it heals
      const held = result.autoMerge.reasons; // why run 1 held each item the rerun defers (a CVE, an adoption)
      const split = await splitHeal(result, { runOnce, log: core.info,
        stage: (r) => stageOutputs(cwd, r, isTracked, (args) => sh('git', args, { cwd })),
        undo: async (r) => {
          await must(['reset', '-q', '--hard', tipStart], cwd);
          // -x within these paths only: adopted dirs are usually gitignored (plugins/).
          await must(['clean', '-fdqx', '--', 'patches', 'patches.lock.json', ...(r.trackedPaths || []), ...(r.adoptedPaths || [])], cwd);
        } });
      result = split.result;
      if (!split.all) { // the full heal defers nothing and stages (and refuses) for itself
        result.classified = keepRefused(result.classified, refused);
        result.security.warn.push(...refusedNotes);
        for (const c of result.classified.filter((x) => x.category === 'deferred')) {
          c.held = held.filter((r) => r.startsWith(`${c.key}: `)).map((r) => r.slice(c.key.length + 2)).join('; ');
        }
      }
      core.info(result.autoMerge.ok
        ? `Mixed heal: merging ${result.autoMerge.eligible.join(', ')} now; the rest waits for the next run's review PR.`
        : `Mixed heal: the part meant to merge now still needs review (${result.autoMerge.reasons.join('; ') || 'nothing left to merge'}); nothing merges unattended.`);
    }
    // Undeployed commits: the same heal (plus the superseded items, at the server's version) on the
    // deployed commit. Its build is what the server runs now — verify checks it, and the built repo
    // gets it — while the tip's heal is what merges into {ref}.
    // Every PR takes this shape, held ones too: merged by hand, a one-commit PR would record the tip
    // (undeployed commits included) as what the server runs.
    if (pending) {
      tipResult = result;
      const tipStaged = await stageOutputs(cwd, result, isTracked, (args) => sh('git', args, { cwd }));
      if (tipStaged.length) {
        // FT's tree is never built before it reaches {ref}: at least prove its lock is valid.
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
        core.info(`${ref} has ${pending.commits} commit(s) not deployed yet (last build: ${pending.since.slice(0, 7)}): the heal is built on that commit and merged next to them.`);
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
  if (inPlace && merged) { await refuse(`New server drift on \`${ref}\` while PR #${inPlace.number} waits: what merging the PR makes already carries the repo change, so nothing joins it.`); return; }
  if (merged) {
    const { sha } = merged;
    await core.summary.addRaw(reportBody(result.classified, { ref, runUrl, already: sha || true })).write();
    await closeStale(repo, branch, `\`${ref}\` already carries every change it proposed${sha ? ` (${sha.slice(0, 7)})` : ''}.`);
    if (sha) {
      // The verify job builds the heal (zero-change dry run, its own pending paths ignored) and records it in the built repo.
      // The record names the merge commit when {ref}'s tip is the heal's tree (nothing undeployed on top);
      // otherwise the heal itself, the deployed tree. Its pending lines live on the heal either way.
      const treeOf = async (rev) => (await sh('git', ['rev-parse', `${rev}^{tree}`], { cwd, silent: true })).out.trim();
      const rec = (await treeOf(baseSha)) === (await treeOf(sha)) ? baseSha : sha;
      core.setOutput('head-sha', baseSha);
      core.setOutput('build-sha', rec);
      core.setOutput('pending-paths', pendingOf((await sh('git', ['show', '-s', '--format=%B', sha], { cwd, silent: true })).out));
      core.notice(`${ref} already has the server's state in ${sha.slice(0, 7)}, merged but not recorded in the built repo: recording ${rec === sha ? 'it' : `its merge ${rec.slice(0, 7)}`}. No PR, nothing deployed.`);
    } else if (result.classified.some((c) => c.recoverable)) {
      core.notice(`${ref} already carries every repo change, in commits not deployed yet: the next Deploy ships them. No PR.`);
    }
    const open = remaining(result.classified);
    if (open) core.setFailed(`Drift remains: ${open}. See the job summary.`);
    else if (sha) endRun(core, noCommitFailure('reconciled', ref, true), true);
    return;
  }

  // 3. Stage only reconcile's outputs, before the body and verdict are read: git may refuse an item.
  const staged = await stageOutputs(cwd, result, isTracked, (args) => sh('git', args, { cwd }));

  // With undeployed commits the PR shows the tip's heal (run A); merging, verify and the built repo
  // follow the heal on the deployed commit (run B).
  const { classified, applied, verification } = tipResult || result;
  const { security, autoMerge } = combineRuns(tipResult, result);
  const { outcome } = result; // what gets built: run B when there are undeployed commits
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
  // Undeployed commits and a heal that needs no review: the heal is recorded on its own and the
  // undeployed tip goes to its engineers in a PR (tipNote, below). Held, one PR carries both, as before.
  const toEngineers = !!(tipResult && autoMergeOn && autoMerge && autoMerge.ok);
  // One PR per ref: drift that needs review can't join the engineers' PR (merging it deploys), and no
  // second PR opens while it waits. The mixed heal's eligible part joins; the rest waits for its merge.
  if (inPlace && (!toEngineers || !staged.length)) {
    await core.summary.addRaw(body).write();
    await refuse(`New server drift on \`${ref}\` while PR #${inPlace.number} waits ${staged.length ? 'needs a review' : 'leaves nothing to commit'}, so it can't join that PR (see the run's summary).`);
    return;
  }
  const prBranch = toEngineers ? tipBranch : branch;
  const logins = toEngineers ? engineerLogins((await sh('gh', ['api', `repos/${repo}/compare/${pending.since}...${baseSha}`, '-q', '.commits[] | (.author.login // empty), (.committer.login // empty)'], { silent: true })).out,
    (await sh('gh', ['api', 'user', '-q', '.login'], { silent: true })).out.trim()) : [];
  if (tipResult && !toEngineers) {
    body = undeployedNote(ref, pending, classified) + body;
  }

  // Compromise signals in server-derived content: say so first, and tell the workflow (no merge,
  // Slack ping). The PR still opens/updates so a human sees exactly what was found.
  const crit = (security && security.critical) || [];
  const warn = (security && security.warn) || [];
  core.setOutput('suspicious', crit.length ? 'true' : 'false');
  if (crit.length || warn.length) {
    const line = (h) => `- \`${h.file}${h.line ? `:${h.line}` : ''}\` — ${h.rule}${h.notInPr ? ' (not in this PR, still on the server)' : ''}`; // line 0: the whole file
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
    : toEngineers
      ? '**Self-heal:** recorded as deployed only if a build of the heal reproduces the server exactly; this PR itself is never merged automatically.\n\n'
      : autoMerge && autoMerge.ok
        ? '**Auto-merge:** eligible — merged only if a build of this branch reproduces the server exactly.\n\n'
        : heldNote(reasonLines)) + body;
  // Read back by the next run that rewrites the PR (pr-trace).
  const state = prState(classified, { auto: autoMergeOn && !!(autoMerge && autoMerge.ok),
    reasons: autoMergeOn ? (autoMerge && autoMerge.reasons) || [] : ['auto-merge is off for this repo'] });
  // Joined in place: the PR still carries the earlier heals' items (the body below shows this heal's).
  const earlier = inPlace ? ((readState(inPlace.body) || {}).items || []).filter((k) => !state.items.includes(k)) : [];
  if (earlier.length) body += `\n**Earlier heals in this PR (already recorded):** ${earlier.map((k) => `\`${k}\``).join(', ')}.\n`;
  state.items = [...new Set([...state.items, ...earlier])].sort();
  body += stateMarker(state);

  if (outcome === 'noop') {
    await core.summary.addRaw('## Consistency reconciliation\n\nNo actionable drift classified (all manifest entries were noise/directories).').write();
    core.warning('No actionable drift classified.');
    return;
  }

  // Commit only what was staged.
  if (!staged.length) {
    // No PR, so no PR wording (a withdrawn suspicious heal keeps its PR, and its body, below).
    const suspicious = classified.some((c) => c.category === 'suspicious');
    let recording = false;
    await core.summary.addRaw(suspicious ? body : reportBody(classified, { ref, runUrl, already: true })).write();
    if (outcome === 'ignorable-only') {
      core.warning('Drift is entirely ignorable. Recommend updating SSH_IGNORE_LIST; see job summary.');
    } else {
      // Source already carries every recoverable fix (e.g. a heal whose built push failed last
      // run): let the gate rebuild {ref} as-is — if that converges it only commits the built repo.
      // Not when the built repo already records {ref}'s tip, or the tip only adds the heal's merge
      // commit on top of the record: that rebuild would record nothing.
      recording = !(await recorded(await lastBuild(treeRoot), cwd, baseSha));
      if (recording) core.setOutput('head-sha', baseSha);
    }
    // A withdrawn (suspicious) heal also leaves nothing to commit: keep its PR as the evidence.
    if (suspicious) {
      await updatePr(repo, ref, branch, body, runUrl); // the open PR says what was found now
    } else {
      await closeStale(repo, branch, 'the repo already carries every change this reconciliation proposed (nothing left to commit).');
    }
    const recovery = isRecovery(recording && !crit.length && !suspicious, classified); // suspicious: the verify job is skipped
    endRun(core, noCommitFailure(outcome, ref, recovery), recovery);
    return;
  }

  // With undeployed commits this is R, the parity commit: [commit only] is what happens to it (built
  // after a zero-change dry run, never rsynced).
  // Without undeployed commits the merge commits this commit into {ref}, and the
  // push-triggered Deploy finds it through the PR and reads its message: [commit only] = build it, require a
  // zero-change dry run, commit the build, never rsync; Self-heal-pending = paths left for review.
  // Merged by hand, the PR carries everything it applies: only what it leaves alone is pending.
  const pendingLines = ((autoMerge && pendingOnMerge(autoMergeOn, autoMerge)) || []).map((p) => `Self-heal-pending: ${p}`);
  const committed = await sh('git', ['commit', '-m', tipResult
    ? [`Reconcile server drift on ${ref} [commit only]`, '', `Parity with the server: the last deployed commit (${pending.since.slice(0, 7)}) plus the server's changes.`,
      ...(pendingLines.length ? ['', ...pendingLines] : [])].join('\n')
    : [`Reconcile server drift on ${ref} [commit only]`, '', healCommitLine(autoMergeOn && autoMerge && autoMerge.ok),
      ...(pendingLines.length ? ['', ...pendingLines] : [])].join('\n')], { cwd });
  if (committed.code !== 0) { core.setFailed(`git commit failed:\n${committed.out}`); return; }
  let headSha = (await sh('git', ['rev-parse', 'HEAD'], { cwd })).out.trim();
  let buildSha = '';
  let layout = '';
  if (tipResult) {
    // The owner's graph (2026-10-20). R (this commit) = the deployed commit D + the server's drift.
    // RM = merge(D, R), "reconciled on top of the old tip": R's tree, what the server runs and what
    // the built repo records (the deployed commit is a merge commit, as without undeployed commits).
    // FT = merge(RM, U), the final tip: the undeployed commits on top, with the tip's heal as its tree
    // (run A: a heal patch added next to any developer patch, never replacing one).
    // RM carries the heal title and the Self-heal-pending lines: once recorded, Deploy's guard reads them there.
    const parity = headSha;
    const rm = await sh('git', ['commit-tree', `${parity}^{tree}`, '-p', pending.since, '-p', parity, '-m',
      [`Reconcile server drift on ${ref} [commit only]`, '', `Reconciled on top of the last deployed commit (${pending.since.slice(0, 7)}): the server's state, which the built repo records.`,
        ...(pendingLines.length ? ['', ...pendingLines] : [])].join('\n')], { cwd });
    if (rm.code !== 0) { core.setFailed(`git commit-tree failed:\n${rm.out}`); return; }
    buildSha = rm.out.trim();
    // The head (lib/tip-head): RM itself when git merges it with U into exactly the heal on the tip, so
    // the merge button writes the final tip merge(U, RM); else FT, a resolving merge with run A's tree.
    // In place, the open PR's head stays an ancestor (it only gains commits).
    // To the engineers: merging it is a normal Deploy (no [skip deploy]). Held: the reconciliation PR,
    // merged by hand [commit only] as before, so its undeployed commits wait for the next Deploy.
    let tip;
    try {
      tip = await tipHead({ git: (...args) => sh('git', args, { cwd, silent: true }), base: baseSha, rm: buildSha, tipTree, prev: inPlace ? inPlace.head : '',
        message: toEngineers
          ? [`Merge ${ref}'s ${pending.commits} undeployed commit(s) on top of the self-heal`, '',
            `The heal ${buildSha.slice(0, 7)} is what the server runs; git can't merge it with ${ref} into the heal on ${ref} by itself, so this merge does: merging this PR deploys these commits on top of the heal.`].join('\n')
          : [`Apply the ${pending.commits} commit(s) not deployed yet after parity [skip deploy]`, '',
            `Parity with the server is ${buildSha.slice(0, 7)}; these changes are still not deployed — the next Deploy of ${ref} ships them.`].join('\n') });
    } catch (e) { core.setFailed(String(e.message || e)); return; }
    headSha = tip.head;
    layout = tip.layout;
    core.info(`PR head: ${layout === 'RM' ? `the heal ${buildSha.slice(0, 7)} itself (it merges cleanly with ${ref})` : `${headSha.slice(0, 7)}, a merge resolving the heal ${buildSha.slice(0, 7)} with ${ref}`}.`);
    await sh('git', ['checkout', '-q', '-B', prBranch, headSha], { cwd });
    if (toEngineers) body = tipNote(ref, { commits: pending.commits, since: pending.since, rm: buildSha, logins, joined: !!inPlace }) + body;
    // A PR that replaced a closed one keeps saying so when a join rewrites its body.
    if (toEngineers && inPlace) body = keptReplacesNote(inPlace.body) + body;
  }
  // Skip the push when the open branch already holds this exact result on this exact base:
  // a new commit every run would dismiss any review on the PR (stale-review ruleset).
  const remote = await sh('git', ['fetch', 'origin', prBranch], { cwd });
  const rev = async (r) => (await sh('git', ['rev-parse', r], { cwd, silent: true })).out.trim();
  const msg = async (r) => (await sh('git', ['log', '-1', '--format=%B', r], { cwd, silent: true })).out;
  const same = remote.code === 0 && await branchSame({ rev, msg, baseSha, buildSha, since: buildSha && pending.since, layout });
  if (same) {
    headSha = await rev('FETCH_HEAD');
    if (buildSha) buildSha = isHealSubject(await msg('FETCH_HEAD')) ? headSha : await rev('FETCH_HEAD^1');
    core.info(`${prBranch} already holds this reconciliation on ${baseSha.slice(0, 7)}; not pushing.`);
  } else {
    // The engineers' PR, joined in place, only moves forward: never a force push. A fresh branch may
    // replace a leftover one (no open PR follows it).
    const push = await sh('git', ['push', ...(inPlace ? [] : ['--force']), 'origin', prBranch], { cwd });
    if (push.code !== 0) { core.setFailed(`git push failed:\n${push.out}`); return; }
  }
  core.setOutput('head-sha', headSha);
  core.setOutput('build-sha', buildSha);

  // 4. Upsert the PR via gh (GH_TOKEN is in env); the description is rewritten every run.
  // The undeployed-tip PR supersedes an open reconciliation PR (one PR per ref).
  if (toEngineers) await closeStale(repo, branch, `superseded by the PR from \`${tipBranch}\`: the heal is recorded on its own and the undeployed commits go to their engineers.`);
  const prTitle = toEngineers ? tipTitle(ref) : `Reconcile server drift on ${ref} [commit only]`;
  const updated = await updatePr(repo, ref, prBranch, body, runUrl, prTitle,
    inPlace && joinedComment(readState(inPlace.body), readState(body), { prior: inPlace.rm, rm: buildSha, from: inPlace.head, to: headSha, runUrl }));
  if (updated === false) return;
  let prNum = updated;
  if (!updated) {
    const bodyFile = path.join(process.env.RUNNER_TEMP || '/tmp', `reconcile-body-${ref}.md`);
    fs.writeFileSync(bodyFile, body);
    // [commit only] in the title too: a squash merge's commit takes it, so a hand merge never deploys.
    // Not the undeployed-tip PR's: merging that one must deploy.
    const created = await sh('gh', ['pr', 'create', '-R', repo, '--head', prBranch, '--base', ref, '--title', prTitle, '--body-file', bodyFile]);
    if (created.code !== 0) { core.setFailed(`gh pr create failed:\n${created.out}`); return; }
    core.info(`Opened PR: ${created.out.trim()}`);
    prNum = (created.out.match(/\/pull\/(\d+)/) || [])[1] || '';
    core.setOutput('pr', prNum);
  }
  if (toEngineers && prNum) {
    await routeTipPr(repo, prNum, logins);
    core.setOutput('undeployed-pr', prNum);
    core.setOutput('engineers', logins.map((l) => `@${l}`).join(', '));
  }

  await core.summary.addRaw(body).write();
  core.setOutput('outcome', outcome);
  core.setOutput('branch', prBranch);

  // 5. Keep the job RED when unrecoverable drift remains (so Slack/ServiceApp alerting fires).
  const left = remaining(classified);
  if (left) core.setFailed(`Reconciliation ran, but drift remains: ${left} — see PR body.`);
})().catch((e) => core.setFailed(e.stack || String(e)));
