'use strict';

/**
 * Does the fetched reconciliation branch (FETCH_HEAD) already hold this run's result (HEAD)?
 * Same tree, same base and same message: the message carries [commit only] and the
 * Self-heal-pending lines the Deploy reads, so a changed message must be pushed too.
 * With buildSha (parity layout: R = buildSha, F = HEAD) the message compared is R's: F's own
 * message only restates baseSha (checked) and R's short sha (new every run).
 * @param {{ rev: (r: string) => Promise<string>, msg: (r: string) => Promise<string>,
 *   baseSha: string, buildSha?: string, since?: string }} o
 */
async function branchSame({ rev, msg, baseSha, buildSha, since }) {
  if (await rev('FETCH_HEAD^{tree}') !== await rev('HEAD^{tree}')) return false;
  if (!buildSha) return await rev('FETCH_HEAD^') === baseSha && await msg('FETCH_HEAD') === await msg('HEAD');
  return await rev('FETCH_HEAD^2') === baseSha
    && await rev('FETCH_HEAD^1^{tree}') === await rev(`${buildSha}^{tree}`)
    && await rev('FETCH_HEAD^1^') === since
    && await msg('FETCH_HEAD^1') === await msg(buildSha);
}

module.exports = { branchSame };
