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

## Reconciliation (opt-in)

When the consistency check **fails** (the server filesystem has drifted from the deployed build), an optional reconcile step can attempt to capture recoverable drift back into source and open a pull request — so the repo catches up to what is actually running, rather than requiring a manual forced redeploy.

### Enabling reconciliation

Set the repository configuration variable `SAUCAL_CONSISTENCY_RECONCILE` to `1`. If the variable is absent or any value other than `1`, reconciliation is disabled (the current default). The reusable workflow (`saucal/action-maintenance/.github/workflows/consistency-check.yml`) reads the variable and passes it to this action as the `reconcile` input.

```bash
gh variable set SAUCAL_CONSISTENCY_RECONCILE -R saucal/<repo> -b 1
```

### What it does

Each drifted path is classified. Recoverable cases are applied to the source tree and committed:

- **Missing plugin/theme on wpackagist** — package found on [wpackagist.org](https://wpackagist.org): added to `composer.json` as `wpackagist-plugin/<slug>` or `wpackagist-theme/<slug>` at the detected version.
- **Premium plugin/theme on SatisPress** — package found on `packages.saucal.com`: added as the corresponding `saucal/<slug>` package.
- **Version drift** — server version differs from the composer-pinned one: version constraint bumped to match.
- **WordPress core drift** — flagged for a core bump (handled via `prepare-composer`; not auto-applied yet).

### What it flags in the PR (not auto-fixed)

- **Premium plugins not on wpackagist or SatisPress** → marked "needs review" (add to SatisPress or vendor manually).
- **Sensitive files** (credentials, `.env`, etc.) → never auto-committed.
- **Hand-edited compiled assets** (`*.min.js`, `/build/`, `/dist/`) → unrecoverable; flagged.
- **Runtime/junk files** (logs, debug JSON, etc.) → recommends adding them to `SSH_IGNORE_LIST` / `SSH_IGNORE_LIST_EXTRA`.
- **Files present in the build but missing on the server** → flagged as "needs redeploy".

### The PR

A branch named `reconciliation-{ref}` (e.g. `reconciliation-main`, `reconciliation-develop`) is recreated from the latest `{ref}` on every run and a PR targeting the checked branch is opened or updated in place — idempotent, no duplicates. The full drift report lives in the PR body only; nothing extra is committed. The PR's normal build CI acts as the retest.

### Check status

The consistency check remains **red** whenever real drift exists — including when a reconciliation PR is open — so existing Slack and status-check alerting still fires. If the only drift is purely ignorable files (junk/logs), no PR is opened and the report is written to the job summary instead.

### New inputs

| Input | Default | Description |
|---|---|---|
| `reconcile` | `false` | Set to `true` to enable reconciliation. |
| `source` | `source` | Folder of the source repo to apply changes to. |
| `github-token` | — | Token used to open/update the reconciliation PR. |
| `satispress-url` | `https://packages.saucal.com` | SatisPress registry URL for premium package lookups. |
| `reconcile-adopt-non-composer` | `false` | Also adopt files not managed by Composer. |

### Phase 2 (planned)

Once the feature is proven in production, the opt-in gate will flip: reconciliation will be **enabled by default** and disabled only when `SAUCAL_CONSISTENCY_RECONCILE` is set to `0` (opt-out).
