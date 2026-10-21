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
and fast-forwards the branch to it with `[commit only]`: the build is committed to the built repo, the
server is not touched. The variables are documented in action-maintenance `docs/variables.md`.

### What it does

Each drifted path is classified, and each component is healed with the first strategy that works:

1. **Version** — the server's exact version through composer (lock moves, ranges kept, pins respected),
   including plugins/themes on wpackagist or SatisPress that the repo doesn't require yet, removals,
   downgrades and `extra.wordpress-core`.
2. **Patch** — a server edit to a registry package becomes a patch (`saucal/composer-patches` >=1.1.0,
   added only when needed).
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
code snippets, DB admin…). Compromise signals mark the PR **🚨 Security review required**, ping Slack
and are never merged.

### Commits not deployed yet

When the branch is ahead of the last deployed commit, the heal is built on the deployed commit
(parity, what the built repo records) and the undeployed commits are applied after it with
`[skip deploy]`; the next Deploy ships only those commits.

### The PR

`reconciliation-{ref}` is cut from the latest `{ref}` and updated in place (no push when the tree is
unchanged). The drift report lives in the PR body. Once the server matches the build again, or there
is nothing left to commit, an open reconciliation PR is closed with a comment and its branch deleted.
The check stays **red** whenever real drift exists, so alerting still fires.

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
