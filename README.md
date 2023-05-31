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
    - cron:  '20 5,17 * * *' # Run at 5:20 & 17:20 every day.

jobs:
  build:
    name: Check consistency
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
```
