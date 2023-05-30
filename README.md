# BUNDLE: Push to SSH

This action is a bundle of other actions which simplifies the workflow definition process for our standard wp-content rooted projects.

This action performs consistency checks before deploying anything. 
There are 2 types of consistency checks: 

1. Pre-build consistency check
2. Post-build consistency check

The pre-build consistency check runs when `dry-run` is `true`, and what it does is checking if the built branch of the target built repo is consistent with the target system (remote). It is very fast (as it does not build) and is designed to be run in a scheduled workflow. 

The post-build consistency check runs before an actual deployment is attempted, so `dry-run` is not explicitly set and also `disable-consistency-check` is not set. This check will compare the GIT manifest, so the files that GIT sees that have changed between the last commit in the built repo to the output of an `rsync --dry-run`. If these 2 do not match, then rsync wants to deploy a different set of files than what GIT knows that changed, and the action will fail. 

## Getting Started

This is the most common configuration

```yml
name: Deploy to [PRODUCTION|STAGING] via SSH
on:
  push:
    branches:
      - ...
  workflow_dispatch:
    inputs:
      disable-consistency-check:
        type: boolean
        description: Disable consistency check

jobs:
  build:
    name: Build
    runs-on: ubuntu-latest
    concurrency: deployment-${{ github.ref_name }}
    steps:
      ...
      ...
      ...
      - name: Push to SSH
        uses: saucal/action-bundle-push-to-ssh@v1
        with:
          env-host: ${{ secrets.ENV_HOST }}
          env-port: ${{ secrets.ENV_PORT }}
          env-user: ${{ secrets.ENV_USER }}
          env-pass: ${{ secrets.ENV_PASS }}
          env-remote-root: ${{ secrets.ENV_REMOTE_ROOT }}
          disable-consistency-check: ${{ github.event.inputs.disable-consistency-check }}
```

## Full options

```yml
- uses: saucal/action-bundle-push-to-ssh@v1
  with:
    # Folder where source code is already built
    source: "source"

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

    # Forced .gitignore entries (appended at the end)
    force-ignore: |
      /auth.json
      /vendor/*
      !/vendor/composer
      /vendor/composer/*
      !/vendor/composer/installers
      !/vendor/composer/installed.json

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

    # Wether to not do a consistency check and complete the workflow regardless. [true|false]
    disable-consistency-check: ""
```
