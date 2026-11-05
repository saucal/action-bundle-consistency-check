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
const tipNote = (ref, { commits, since, rm, logins }) => [
  `## ⚠️ ${commits} commit(s) on \`${ref}\` were not deployed when the server was healed`, '',
  `${logins.length ? `For ${logins.map((l) => `@${l}`).join(', ')}: these are your commits.` : '**No GitHub user was found for these commits: assign this PR by hand.**'} `
  + `The server's drift is healed on the last deployed commit (\`${since.slice(0, 7)}\`) as \`${rm.slice(0, 7)}\`, which the built repo records as deployed once a build of it reproduces the server. `
  + `This PR merges your undeployed commits on top of that heal. **It is never merged automatically**: merging it runs a normal Deploy of \`${ref}\` that ships them.`, '',
  `Until it merges, a Deploy of \`${ref}\` is refused (it would undo the heal). Push further work to \`${ref}\` as usual: it ships with this merge.`, '', ''].join('\n');

module.exports = { tipBranchOf, TIP_LABEL, tipTitle, engineerLogins, tipNote };
