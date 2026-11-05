'use strict';

/**
 * Does the fetched reconciliation branch (FETCH_HEAD) already hold this run's result (HEAD)?
 * Same tree, same base and same message: the message carries [commit only] and the
 * Self-heal-pending lines the Deploy reads, so a changed message must be pushed too.
 * With buildSha (parity layout: RM = buildSha = merge(since, R), FT = HEAD = merge(RM, base)) the
 * message compared is RM's: FT's own message only restates RM's short sha (new every run). A branch
 * in the older layout (F's 1st parent R itself, a single-parent commit) is never the same.
 * layout 'RM' (lib/tip-head: the head is RM itself, it merges cleanly with base): the fetched head
 * is compared as the heal, and base doesn't matter (RM doesn't contain it).
 * @param {{ rev: (r: string) => Promise<string>, msg: (r: string) => Promise<string>,
 *   baseSha: string, buildSha?: string, since?: string, layout?: string }} o
 */
async function branchSame({ rev, msg, baseSha, buildSha, since, layout }) {
  if (await rev('FETCH_HEAD^{tree}') !== await rev('HEAD^{tree}')) return false;
  if (!buildSha) return await rev('FETCH_HEAD^') === baseSha && await msg('FETCH_HEAD') === await msg('HEAD');
  const heal = layout === 'RM' ? 'FETCH_HEAD' : 'FETCH_HEAD^1';
  return (layout === 'RM' || await rev('FETCH_HEAD^2') === baseSha)
    && await rev(`${heal}^{tree}`) === await rev(`${buildSha}^{tree}`)
    && await rev(`${heal}^1`) === since
    && await rev(`${heal}^2^{tree}`) === await rev(`${buildSha}^{tree}`)
    && await msg(heal) === await msg(buildSha);
}

module.exports = { branchSame };
