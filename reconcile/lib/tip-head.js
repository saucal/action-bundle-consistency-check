'use strict';

/**
 * The head of a PR that carries a heal next to commits not deployed yet (owner, 2026-11-04 refinement).
 * RM = merge(D, R) is the heal. The head is RM itself when git merges RM and {ref}'s tip U into exactly
 * the heal replayed on the tip (run A's tree): the merge button then writes the final tip merge(U, RM).
 * Otherwise (a conflict in composer.json/lock, patches.lock.json, ..., or a clean merge that differs
 * from run A) a resolving merge FT with run A's tree goes on top, 1st parent the heal (Deploy and the
 * check find the heal there).
 * An open PR's head only ever moves forward: no force push, so the old head stays an ancestor.
 */

const isHealSubject = (subject) => /^Reconcile server drift on /.test(String(subject || ''));

/** The heal a PR head carries: the head itself (RM layout) or its 1st parent (FT layout). */
const healOf = (head, subject, parent0) => (isHealSubject(subject) ? head : parent0 || '');

/** git(...args) => { code, out } */
async function isAncestor(git, a, b) {
  return (await git('merge-base', '--is-ancestor', a, b)).code === 0;
}

/** The tree git's merge of a and b writes, '' on a conflict (git >= 2.38). */
async function mergedTree(git, a, b) {
  const r = await git('merge-tree', '--write-tree', '--no-messages', a, b);
  return r.code === 0 ? r.out.trim().split('\n')[0] : '';
}

/**
 * What GitHub would make by merging the open PR's head into {ref}'s tip: a local commit (never pushed)
 * the heal on the tip is built on, so a heal joining the PR keeps the earlier heals. null on a conflict.
 */
async function materializeTip(git, base, head, message) {
  if (await isAncestor(git, head, base)) return base;
  const tree = await mergedTree(git, base, head);
  if (!tree) return null;
  const c = await git('commit-tree', tree, '-p', base, '-p', head, '-m', message);
  return c.code === 0 ? c.out.trim() : null;
}

/**
 * The PR head for heal `rm` next to tip `base`, whose heal on the tip has tree `tipTree`.
 * @param {{ git: Function, base: string, rm: string, tipTree: string, prev?: string, message: string }} o
 *   prev = the open PR's head when this heal joins it in place.
 * @returns {Promise<{ head: string, layout: 'RM'|'FT' }>} throws when commit-tree fails
 */
async function tipHead({ git, base, rm, tipTree, prev = '', message }) {
  const prevInRm = !prev || await isAncestor(git, prev, rm);
  if (prevInRm && await mergedTree(git, base, rm) === tipTree) return { head: rm, layout: 'RM' };
  const parents = [rm];
  if (!prevInRm) parents.push(prev); // an FT head stays an ancestor: the PR only gains commits
  if (!prev || !(await isAncestor(git, base, prev))) parents.push(base);
  const c = await git('commit-tree', tipTree, ...parents.flatMap((p) => ['-p', p]), '-m', message);
  if (c.code !== 0) throw new Error(`git commit-tree failed:\n${c.out}`);
  return { head: c.out.trim(), layout: 'FT' };
}

module.exports = { isHealSubject, healOf, isAncestor, mergedTree, materializeTip, tipHead };
