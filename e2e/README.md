# Self-heal e2e harness (local, act + docker-wp)

Runs the real reusable workflows (`action-maintenance` `deployment.yml` / `consistency-check.yml`)
locally with [act](https://github.com/nektos/act):

| Plays | What |
|---|---|
| Production host | docker-wp site `ci-test-selfheal` (sshd on, WP pinned to the fixture's `extra.wordpress-core`) |
| GitHub source / built repos | `saucal/ci-test-selfheal` + `-built` — private, Actions **disabled** (only act runs workflows), **reset, never deleted** |
| Every `saucal/action-*` | snapshot of the local repo's `origin/<vN\|main\|master>` (fetched each run) in `.work/actions/` |
| Code under test | this worktree as `action-bundle-consistency-check@v4`, plus `HARNESS_LOCAL_ACTIONS` |

```bash
./harness.sh up                     # create/reset repos, create site, forced first deploy, green check
./harness.sh server wp plugin update duplicate-post --version=4.6   # make drift on "production"
./harness.sh check                  # scheduled consistency check (+ reconcile PR)
./harness.sh deploy [--force]       # push-triggered Deploy (--force = disable-consistency-check)
./harness.sh down                   # reset repos (orphan seed / placeholder), purge the site
```

Test other action branches: `HARNESS_LOCAL_ACTIONS` takes newline-separated `saucal/<repo>@<ref>=/path`
lines, or put them in `e2e/.local-actions` (gitignored, read automatically). Until the self-heal PRs
are merged, map each action under test to its branch checkout: action-maintenance@v3,
action-bundle-prepare@v4, action-bundle-push-to-ssh@v4, action-deploy-ssh@v4,
action-prepare-composer@v3 and action-build-to-git@v2 (the build label fix: without it scenarios
20 and 21 fail on the parity assertion).

Self-heal loop proven here: merchant update + WP core auto-update on the server → check red →
reconcile PR (lock 4.5→4.6, core 6.9.1→7.1.3) → verify (Deploy pipeline, `verify-only=check`) →
merged `[commit only]` → `./harness.sh deploy` (commit mode: built repo advances, server untouched)
→ check green.

Also proven: an FTP edit on a composer plugin already at its latest version (→ cweagans patch,
composer-patches bootstrapped) together with an edit to tracked `custom-plugin` (→ server copy
committed) → auto-merge eligible → verify → merged `[commit only]` → commit deploy → check green.

Also proven (split): a clean tracked edit + a plugin installed on the server whose vulnerability
check can't answer → run 1 merges only the tracked edit (`Self-heal-pending: /plugins/hello-dolly/`
in the merge, verify and commit deploy skip that path) → run 2 opens a review PR with just the
`composer require` ("vulnerability check unavailable").

Logs: `.work/logs/`. Uploaded artifacts (rsync plan, consistency diffs): `.work/artifacts/`.

## Needs

`act` ≥ 0.2.89, Docker, docker-wp (`docker-wp-create-site`), `gh` logged in with `repo` scope
(with rights to merge the sandbox repos' PRs), and the
SatisPress key: read from `SAUCAL_SATIS_KEY`, else `e2e/.secrets.env`, else the operator's
global composer auth. The site's sshd is published on `0.0.0.0:2299` (random password in `.work/`).

## act-only workarounds (not behaviour changes)

- `runner.Dockerfile`: GitHub runners ship apt lists, rsync, PHP/Composer and gh; act's image doesn't.
- `overlay-checkout-extended.py`: act ignores an *expression* `continue-on-error` on a nested
  `uses:` step, so a first deploy's "Checkout previous build (if any)" would fail the job. The
  overlay makes it literal and re-fails when the caller didn't opt in.
- `up` pre-creates `-built`, so `maybe-create-repo`'s create path is not exercised.
