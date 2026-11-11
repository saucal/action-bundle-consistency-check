# BUNDLE: Consistency check

This action is a clone of the [Push to SSH bundle](https://github.com/saucal/action-bundle-push-to-ssh) meant to run a pre-build consistency check.

It is checking if the built branch of the target built repo is consistent with the target system (remote). It is very fast (as it does not build anything) and is designed to be run in a scheduled workflow or manually. 

The contents of the branch that trigger the action (if run manually) do not play a role for the action's outcome.

If the slack token and channel are configured, it will post a message on slack **only on failure**.


## Getting Started

This is the most common configuration

```yml
name: Filesystem Consistency check
on:
  workflow_dispatch:
  schedule:
    - cron:  '0 0,12 * * *' # Run at 0:00 & 12:00 (UTC) every day.

jobs:
  build:
    name: Check consistency on ${{ github.ref_name }}
    runs-on: ubuntu-latest
    concurrency: deployment-${{ github.ref_name }}
    steps:
      - name: Prepare
        uses: saucal/action-bundle-prepare@v1
        with:
          git-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Consistency Check (main <-> production)
        if:  ${{ github.ref_name == 'main' }}
        uses: saucal/action-bundle-consistency-check@v1
        with:
          env-host: ${{ secrets.ENV_PRODUCTION_HOST }}
          env-user: ${{ secrets.ENV_PRODUCTION_USER }}
          env-pass: ${{ secrets.ENV_PRODUCTION_PASS }}
          env-port: ${{ secrets.ENV_PRODUCTION_PORT }}
          env-remote-root: ${{ secrets.ENV_PRODUCTION_REMOTE_ROOT }}
          slack-token: ${{ secrets.SLACK_CI_BOT_TOKEN }}
          slack-channel: "..." # The channel's ID

      - name: Consistency Check (develop <-> staging)
        if:  ${{ github.ref_name == 'develop' }}
        uses: saucal/action-bundle-consistency-check@v1
        with:
          env-host: ${{ secrets.ENV_STAGING_HOST }}
          env-user: ${{ secrets.ENV_STAGING_USER }}
          env-pass: ${{ secrets.ENV_STAGING_PASS }}
          env-port: ${{ secrets.ENV_STAGING_PORT }}
          env-remote-root: ${{ secrets.ENV_STAGING_REMOTE_ROOT }}
          slack-token: ${{ secrets.SLACK_CI_BOT_TOKEN }}
          slack-channel: "..." # The channel's ID
```

## Full options

```yml
- uses: saucal/action-bundle-push-to-ssh@v1
  with:
    # Folder of the repo that things will be pushed to
    built: "built"

    # SSH Host to use to connect
    env-host: ""

    # SSH Port to use to connect
    env-port: ""

    # SSH User to use to connect
    env-user: ""

    # SSH key to use to connect to the host. Prefer this instead of a key if available.
    env-key: ""

    # SSH Password to use to connect, instead of a key.
    env-pass: ""

    # SSH Root to push to
    env-remote-root: ""

    # SSH Flags to pass to the RSync command
    ssh-flags: "avrcz"

    # Parameters to be passed to the SSH shell command
    ssh-shell-params: ""

    # Extra options for the RSync command
    ssh-extra-options: "delete no-inc-recursive size-only ignore-times omit-dir-times no-perms no-owner no-group no-dirs"

    # Ignore rules. Each line will generate an extra --exclude=... parameter for rsync.
    ssh-ignore: |
      .git
      wp-debug.log
      uploads/
      /vendor/**
      /auth.json
      /composer.json
      /composer.lock
      /object-cache.php
      /db.php

    # Slack token to use when posting to Slack
    slack-token: ""

    # Slack channel to post to use when posting to Slack
    slack-channel: ""

    # Whether or not the pre script will be executed.
    run-ssh-pre: true

    # Whether or not the post script will be executed.
    run-ssh-post: true
```

## Reconciliation (self-heal)

When the check **fails** because the server drifted from the deployed build, the reconcile step
brings the **source repo** in line with the server, the way an engineer doing a manual sync would,
and opens a `reconciliation-{ref}` PR. Nothing is deployed to heal.

It is driven by the reusable workflow `saucal/action-maintenance/.github/workflows/consistency-check.yml`,
which passes the `reconcile` input from the `SAUCAL_CONSISTENCY_RECONCILE` variable and, for heals that
need no review, verifies the PR head reproduces the server exactly (a zero-change dry run of its build)
and merges it with a merge commit, `[commit only]`: the build is committed to the built repo, recorded
as that merge commit, and the server is not touched. The variables are documented in action-maintenance `docs/variables.md`.

### What it does

Each drifted path is classified, and each component is healed with the first strategy that works:

1. **Version** — the server's exact version through composer (lock moves, ranges kept, pins respected),
   including plugins/themes on wpackagist or SatisPress that the repo doesn't require yet, removals,
   downgrades and `extra.wordpress-core`.
2. **Patch** — a server edit to a registry package becomes a patch (`saucal/composer-patches` >=1.1.0,
   added only when needed). The heal owns only `patches/<slug>.patch`: a project's own patches for the
   package are kept, and the heal's patch is cut on top of them and listed after them. When the server
   no longer carries one of them (undone, or edited over), the item is held "needs resolution".
3. **Tracked file** — a server edit to a file the repo already tracks is copied back.
4. **Adoption** — server-only code copied into the repo; last resort, always left for review
   (`reconcile-adopt-non-composer`).

Runtime/junk files are reported with a suggested ignore rule; sensitive files are never committed;
hand-edited compiled assets and files missing on the server are flagged.

### Review and security

Everything taken from the server without registry provenance is scanned. A heal is held for review
(the rest still merges) when it adds a file, touches a must-use plugin, adds a script tag or an
external URL, reads request data, changes JS/shell/package-manager files, matches a compromise
pattern, adds a known-vulnerable or unchecked version, or adds a high-risk plugin (file managers,
code snippets, DB admin…). A WordPress core version that is known-vulnerable or unchecked holds the
whole heal (nothing merges without it). Compromise signals mark the PR **🚨 Security review required**, ping Slack
and are never merged.

### Commits not deployed yet

When the branch is ahead of the last deployed commit D (undeployed commits ending in U), the heal R is
built on D, and the graph is:

```
merge(U, RM)       final tip: GitHub's merge button, when the engineers merge the PR
RM  merge(D, R)    "reconciled on top of the old tip": the PR head, what the built repo records (R's tree)
R   the heal on D
```

The PR from `selfheal-undeployed-{ref}` has RM itself as its head, so its merge button writes the final
tip. Only when git can't merge RM and U into exactly the heal replayed on U (a conflict in
`composer.json`, `composer.lock`, `patches.lock.json`..., or a clean merge that differs) does a resolving
merge FT = merge(RM, U) with that tree go on top. FT's tree is the heal on U, made as before (drifted
code the undeployed commits also changed is held for review).

A heal that needs no review is verified on RM, and RM is recorded as deployed. Nothing lands on
`{ref}`. The PR goes to the engineers who made the undeployed commits: it is assigned to them, they
are asked to review it, and it is labelled `self-heal/undeployed`. Merging it runs a normal Deploy that
ships those commits on top of the heal. Until then, a Deploy of `{ref}` is refused (it would undo the
heal).

- **New drift while the PR waits** joins it in place (one PR per ref). The heal R2 is built on the record
  RM, RM2 = merge(RM, R2) is recorded once verified, and the PR head moves to RM2 (or to FT2 = merge(RM2,
  FT), when the head was FT) by adding commits only, never a force push. The heal on the tip is built on
  what merging the PR makes, so it keeps the earlier heals. A comment names what joined. New drift that
  needs a review can't join (merging the PR deploys): the check comments on the PR and stays red.
- **Closed without merging**: while the built repo still records its heal and `{ref}` lacks it, the next
  check (green or not) opens a fresh PR from the same branch that links the closed one (a closed PR is
  never reopened), assigns, labels and announces it again. A forced Deploy is the deliberate way out.
- The PR is closed once the built repo records something its head doesn't contain (e.g. a forced
  Deploy), or when none of its heals was ever recorded and the record is on `{ref}` (its verify failed).

A held heal is two PRs (owner, 2026-11-10). PR 1, from `reconciliation-{ref}`, has R on D as its head
and a temporary `selfheal-base-{ref}` branch at D as its base, so its diff is the heal alone. Merging it
deploys nothing (Deploy skips that branch); its merge commit m1 = merge(D, R) is the heal. The next
check (requested by Deploy on that push when the caller's push trigger lists `selfheal-base-*`, else the
next scheduled one) records m1 once a build of it reproduces the server, opens the engineers' PR above
with m1 as RM, and deletes `selfheal-base-{ref}`. If the server changed since the review, nothing is
recorded and a new PR 1 reviews the heal built on D again. Closed unmerged, PR 1 is never reused: the
next check opens a new one (or, once green, deletes both branches). Without undeployed commits a held heal
is one PR into `{ref}`, as before.

### The PR

`reconciliation-{ref}` is cut from the latest `{ref}` and updated in place (no push when the tree is
unchanged). The drift report lives in the PR body. Once the server matches the build again, or there
is nothing left to commit, an open reconciliation PR is closed with a comment and its branch deleted.
The check stays **red** whenever real drift exists, so alerting still fires.
The one exception is recovery: the branch already carries every repo change and only the built repo's
record is behind (e.g. a heal whose built push failed). The check then ends with a **warning** and the
verify job records the build.

### Inputs and outputs

| Input | Default | Description |
|---|---|---|
| `reconcile` | `''` | `1` enables reconciliation. |
| `source` | `source` | Source tree (where `composer.json` lives). |
| `github-token` | — | Pushes the branch and opens/closes the PR. |
| `reconcile-adopt-non-composer` | `false` | Allow adopting server-only code (always held for review). |
| `sapp-server`, `sapp-vulns-key` (or `sapp-app-user`/`sapp-app-pass`) | | Known-vulnerability check. |

Outputs (`reconcile-head-sha`, `-build-sha`, `-base-sha`, `-pr`, `-auto-merge`, `-pending-paths`,
`-suspicious`) drive the workflow's verify and merge jobs; see `action.yml`.

The end-to-end harness lives in [`e2e/`](e2e/README.md).

> **Structure note:** reconcile (`reconcile/`, ~2k lines of Node) lives in this bundle for now. Bundles
> are meant to be thin composites over real actions (e.g. `action-bundle-push-to-ssh` over
> `action-deploy-ssh`), so it may move to its own action (e.g. `saucal/action-consistency-check`) that
> this bundle calls with the same inputs and outputs.
