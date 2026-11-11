'use strict';

/**
 * Commits not deployed yet when a heal is ready (owner, 2026-11-04): the heal RM = merge(D, R) is
 * recorded as deployed, and a PR merging the undeployed tip U on top of it, FT = merge(RM, U), goes to
 * the engineers who made those commits. Never auto-merged: merging it is a normal Deploy that ships them.
 * Its branch must not start with "reconciliation-" and its title must carry neither "[commit only]"
 * nor "[skip deploy]", or merging it would only record the build (deployment.yml) and ship nothing.
 */
const tipBranchOf = (ref) => `selfheal-undeployed-${ref}`;
const TIP_LABEL = 'self-heal/undeployed';
const tipTitle = (ref) => `Deploy ${ref}'s undeployed commits on top of the self-heal`;

/**
 * GitHub logins that authored or committed the undeployed commits, from `compare` output (one login
 * per line): not the token's own user (it opens the PR), not GitHub's web-flow committer, not bots.
 */
const engineerLogins = (lines, me = '') => [...new Set(String(lines).split('\n').map((l) => l.trim())
  .filter((l) => /^[A-Za-z0-9-]+(\[bot\])?$/.test(l) && l !== me && l !== 'web-flow' && !l.endsWith('[bot]')))];

/** The PR body's opening: who it is for, what is recorded, and what a Deploy does meanwhile. */
const tipNote = (ref, { commits, since, rm, logins, joined = false, reviewed = '' }) => [
  `## ⚠️ ${commits} commit(s) on \`${ref}\` were not deployed when the server was healed`, '',
  `${logins.length ? `For ${logins.map((l) => `@${l}`).join(', ')}: these are your commits.` : '**No GitHub user was found for these commits: assign this PR by hand.**'} `
  + (joined
    ? `New server drift joined this PR: it is healed on the heal recorded before (\`${since.slice(0, 7)}\`) as \`${rm.slice(0, 7)}\`, which the built repo records as deployed once a build of it reproduces the server. `
    : reviewed
      ? `The server's drift was healed on the last deployed commit (\`${since.slice(0, 7)}\`) and reviewed in #${reviewed}; its merge \`${rm.slice(0, 7)}\` is what the built repo records as deployed once a build of it reproduces the server. `
      : `The server's drift is healed on the last deployed commit (\`${since.slice(0, 7)}\`) as \`${rm.slice(0, 7)}\`, which the built repo records as deployed once a build of it reproduces the server. `)
  + `This PR merges your undeployed commits on top of that heal. **It is never merged automatically**: merging it runs a normal Deploy of \`${ref}\` that ships them.`, '',
  `Until it merges, a Deploy of \`${ref}\` is refused (it would undo the heal). New server drift that needs no review joins this PR (a comment says what joined); drift that needs a review waits for this merge. Push further work to \`${ref}\` as usual: it ships with this merge. `
  + 'If the heal left items on the server for review (below), that Deploy is refused on them until they are committed or ignored.', '', ''].join('\n');

/**
 * The trace comment when new drift joins the open PR in place: what joined, the new heal and where the
 * head moved (by adding commits only). Items come from the body's state marker (pr-trace).
 */
const joinedComment = (old, now, { prior, rm, from, to, runUrl }) => {
  const joined = ((now && now.items) || []).filter((k) => !((old && old.items) || []).includes(k));
  return ['New server drift joined this PR in place:', '',
    `- Joined: ${joined.length ? joined.map((k) => `\`${k}\``).join(', ') : '(no new item: the same items changed again on the server)'}`,
    `- The heal \`${rm.slice(0, 7)}\` is built on the recorded heal \`${prior.slice(0, 7)}\`; the built repo records it once a build of it reproduces the server.`,
    `- Head: \`${from.slice(0, 7)}\` → \`${to.slice(0, 7)}\` (commits added on top, no force push). Still never merged automatically.`,
    '', `From the [consistency check run](${runUrl}).`].join('\n');
};

/** The opening of the fresh PR that replaces an engineers' PR closed without merging. */
const recoveredNote = (ref, closed, record, runUrl) => [
  `## ⚠️ Replaces #${closed}, closed without merging`, '',
  `#${closed} was closed, but the built repo still records its heal \`${record.slice(0, 7)}\` as deployed, and \`${ref}\` does not contain it: `
  + `until this merges, a Deploy of \`${ref}\` is refused. A closed PR is never reopened, so the self-heal opened this one from the same branch. `
  + `If the heal must go instead, a forced Deploy (disable-consistency-check) is the deliberate rollback; this PR then closes on the next check. Opened by the [consistency check run](${runUrl}).`, '', ''].join('\n');

/**
 * What to do with the open engineers' PR given the record (the built repo's last build source):
 * 'keep' while it carries the record; 'stale' once the record is something its head doesn't contain;
 * 'unrecorded' when none of its heals was recorded and the record is on {ref} (rebuild from the record).
 * A containment the API could not answer (null) never closes it: closing deletes the branch keeping RM.
 * @param {{ rm: string }} pr  @param {string} record  @param {{ inHead: boolean|null, inRef: boolean|null }} where
 */
const tipPrVerdict = (pr, record, { inHead, inRef }) => {
  if (!record || inHead === null) return 'keep';
  if (!inHead) return 'stale';
  return pr.rm !== record && inRef === true ? 'unrecorded' : 'keep';
};

/**
 * The newest closed engineers' PR is recovered when it was not merged, its head still carries the record
 * (the record is its heal, or an earlier one when a newer joined heal was never verified) and {ref} lacks
 * it. The same containment the open PR's verdict uses; an unanswered API (null) never recovers.
 */
const recoverable = (closed, record, { inHead, inRef } = {}) => !!(closed && record && !closed.merged && inHead === true && inRef === false);

/** The PR listing gh returned ({ code, out }): the PRs, or a throw when the listing failed (never "none"). */
const parseTipPrs = ({ code, out }, what) => {
  if (code !== 0) throw new Error(`listing the ${what} failed, so it is unknown whether an engineers' PR waits; not healing this run:\n${out}`);
  if (!String(out).trim()) return [];
  try {
    const prs = JSON.parse(out);
    if (Array.isArray(prs)) return prs;
  } catch { /* below */ }
  throw new Error(`listing the ${what} returned something unreadable; not healing this run:\n${out}`);
};

/** The "Replaces #N" opening of a PR that replaced a closed one, from its current body ('' when none). */
const keptReplacesNote = (body) => {
  const m = /^## ⚠️ Replaces #\d+, closed without merging\n\n[^\n]*\n\n/m.exec(String(body || ''));
  return m ? m[0] : '';
};

/**
 * Owner decision (2026-11-10, G65): a held heal while commits are undeployed is reviewed on its own. PR 1
 * merges the heal r1 (built on the deployed commit D) into this temporary branch, created at D, so its
 * diff is the heal alone; its merge m1 = merge(D, r1) is then recorded and the engineers' PR follows.
 */
const baseBranchOf = (ref) => `selfheal-base-${ref}`;

/**
 * Is the base branch's head the reviewed heal to record? Only PR 1's own merge commit (2 parents: D, then
 * the merged PR head r1) whose tree is the heal this run builds on D again: the server still runs it.
 * @param {{ parents: string[], prHead: string, since: string, tree: string, healTree: string }} o
 */
const reviewedMerge = ({ parents, prHead, since, tree, healTree }) => !!(parents.length === 2 && parents[0] === since
  && parents[1] === prHead && tree && tree === healTree);

module.exports = { baseBranchOf, reviewedMerge, tipBranchOf, TIP_LABEL, tipTitle, engineerLogins, tipNote, joinedComment, recoveredNote, tipPrVerdict, recoverable, parseTipPrs, keptReplacesNote };
