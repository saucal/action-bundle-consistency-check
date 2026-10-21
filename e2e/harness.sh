#!/usr/bin/env bash
# Local self-heal harness: a docker-wp site plays the production host, a throwaway GitHub
# sandbox repo pair plays the source/-built repos, and act runs the real reusable workflows
# with the actions under test mapped to local checkouts. See e2e/README.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ACTIONS="$(cd "$HERE/../../.." && pwd)"   # the actions/ dir that holds every action checkout
REPO="${HARNESS_REPO:-saucal/ci-test-selfheal}"
BUILT="$REPO-built"
SLUG="${HARNESS_SLUG:-ci-test-selfheal}"
WP_VERSION="${HARNESS_WP_VERSION:-6.9.1}"   # matches the fixture's extra.wordpress-core
SSH_HOST_PORT="${HARNESS_SSH_PORT:-2299}"
WORK="$HERE/.work"
# The cached baseline (site files, DB, both repos' refs): survives `down`, and lives outside this
# action's directory, which act copies into the job containers.
SNAP="${HARNESS_SNAPSHOT:-$HOME/.cache/act-harness-snapshot}"
# Composer cache mounted into job containers, like actions/cache on GitHub. No spaces allowed: act
# splits --container-options on them.
COMPOSER_CACHE_HOST="${HARNESS_COMPOSER_CACHE:-$HOME/.cache/act-harness-composer}"
SRC="$WORK/src"
NETWORK="docker-environment_default"
RUNNER_IMAGE="act-harness-runner:$(shasum "$HERE/runner.Dockerfile" | cut -c1-12)"   # rebuilt when the Dockerfile changes
DWP="$(npm root -g)/docker-environment"

# Every saucal action resolves to a snapshot of its local repo's origin/<branch> (fetched each
# run, so it matches GitHub). Code under test maps to a live checkout instead: this worktree by
# default, plus HARNESS_LOCAL_ACTIONS (newline-separated "saucal/<repo>@<ref>=/path").
[ -z "${HARNESS_LOCAL_ACTIONS:-}" ] && [ -f "$HERE/.local-actions" ] && HARNESS_LOCAL_ACTIONS="$(cat "$HERE/.local-actions")"
UNDER_TEST="saucal/action-bundle-consistency-check@v4=$(cd "$HERE/.." && pwd)
${HARNESS_LOCAL_ACTIONS:-}"
MOCK_SAPP="harness-mock-sapp"   # stand-in for ServiceApp's vulns/match (e2e/mock-sapp)

die() { echo "harness: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }

need_secrets() {
  # shellcheck source=/dev/null
  [ -z "${SAUCAL_SATIS_KEY:-}" ] && [ -f "$HERE/.secrets.env" ] && . "$HERE/.secrets.env"
  # Fall back to the operator's global composer auth (the SatisPress key is the http-basic username).
  [ -z "${SAUCAL_SATIS_KEY:-}" ] && SAUCAL_SATIS_KEY="$(composer global config http-basic.packages.saucal.com.username --quiet 2>/dev/null || true)"
  [ -n "${SAUCAL_SATIS_KEY:-}" ] || die "set SAUCAL_SATIS_KEY (packages.saucal.com key): export it, or put SAUCAL_SATIS_KEY=... in e2e/.secrets.env"
}

site_pass() { cat "$WORK/ssh_pass"; }

cmd_up() {
  need_secrets
  for b in gh act docker docker-wp-create-site git; do command -v "$b" >/dev/null || die "missing $b"; done
  [ -d "$DWP/data/apps/$SLUG" ] && die "docker-wp site $SLUG already exists — run '$0 down' first"
  mkdir -p "$WORK/logs"

  # Repos are created once and kept; every up/down resets them by force-push instead.
  for r in "$REPO" "$BUILT"; do
    if ! gh repo view "$r" >/dev/null 2>&1; then
      log "Creating sandbox $r (private, Actions disabled — only act runs workflows)"
      gh repo create "$r" --private >/dev/null
    fi
    gh api -X PUT "repos/$r/actions/permissions" -F enabled=false >/dev/null
  done
  reset_repos

  log "Creating docker-wp site $SLUG (WP $WP_VERSION) with sshd"
  openssl rand -hex 12 > "$WORK/ssh_pass"; chmod 600 "$WORK/ssh_pass"
  docker-wp-create-site "$SLUG" --wp-version "$WP_VERSION" -y >&2
  printf 'ssh_port: %s\nenv:\n  SSH_PASS: "%s"\n' "$SSH_HOST_PORT" "$(site_pass)" >> "$DWP/data/apps/$SLUG/site.yml"
  docker-wp-start "$SLUG" >&2
  # No surprise core/plugin updates mid-scenario (docker-wp's WP updated itself to 7.1.3 once).
  cmd_server wp config set AUTOMATIC_UPDATER_DISABLED true --raw --type=constant >&2

  # Adoption is the last rung (after composer add/bump and patches) and is held when the security
  # scan finds compromise signals.
  cat > "$WORK/vars" <<EOF
PRODUCTION_SSH_HOST=site-$SLUG
PRODUCTION_SSH_USER=www-data
PRODUCTION_SSH_PORT=2222
PRODUCTION_REMOTE_ROOT=/apps/$SLUG/public_html/wp-content
SAUCAL_CONSISTENCY_RECONCILE=1
SAUCAL_CONSISTENCY_RECONCILE_ADOPT=1
SAUCAL_CONSISTENCY_RECONCILE_MERGE=1
SAPP_SERVER=http://$MOCK_SAPP:8080
PHP_VERSION=8.3
EOF
  log "Baseline: forced first deploy, then a check that must be green"
  cmd_deploy --force || die "baseline deploy failed — see $WORK/logs"
  cmd_check || die "baseline consistency check is not green — see $WORK/logs"
  echo green > "$WORK/state"
  cmd_snapshot
  log "Up and in sync. Make drift with '$0 server …', then '$0 check'."
}

# mirror_actions: print one --local-repository mapping per line, for every v<N>/main/master
# branch of every action repo in $ACTIONS, extracted (unchanged working trees) into .work/actions.
mirror_actions() {
  local d url name b sha dest
  for d in "$ACTIONS"/*/; do
    [ -d "$d.git" ] || continue
    url="$(git -C "$d" remote get-url origin 2>/dev/null)" || continue
    name="$(basename "${url%.git}")"
    case "$url" in *github.com[:/]saucal/*) ;; *) continue ;; esac
    printf '%s\n' "$d"
  done | { if [ -n "$(find "$WORK/.mirrors-fetched" -mmin -10 2>/dev/null)" ]; then cat >/dev/null; else xargs -P 8 -I{} git -C {} fetch -q origin 2>/dev/null; touch "$WORK/.mirrors-fetched"; fi; } || true
  for d in "$ACTIONS"/*/; do
    [ -d "$d.git" ] || continue
    url="$(git -C "$d" remote get-url origin 2>/dev/null)" || continue
    case "$url" in *github.com[:/]saucal/*) ;; *) continue ;; esac
    name="$(basename "${url%.git}")"
    for b in $(git -C "$d" for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin | grep -E '^(v[0-9]+|main|master)$'); do
      grep -q "^saucal/$name@$b=" <<< "$UNDER_TEST" && continue
      sha="$(git -C "$d" rev-parse "origin/$b")"
      dest="$WORK/actions/$name@$b"
      if [ "$(cat "$dest/.harness-sha" 2>/dev/null)" != "$sha" ]; then
        rm -rf "$dest"; mkdir -p "$dest"
        git -C "$d" archive "$sha" | tar -x -C "$dest"
        # act-only workaround, see the script.
        [ "$name" = action-checkout-extended ] && python3 "$HERE/overlay-checkout-extended.py" "$dest/action.yml"
        echo "$sha" > "$dest/.harness-sha"
      fi
      echo "saucal/$name@$b=$dest"
    done
  done
}

# The mock ServiceApp answers vulns/match from .work/mock-sapp/vulns.json (scenarios set it).
ensure_mock_sapp() {
  mkdir -p "$WORK/mock-sapp"
  cp "$HERE/mock-sapp/server.js" "$WORK/mock-sapp/server.js"
  [ -f "$WORK/mock-sapp/vulns.json" ] || echo '{}' > "$WORK/mock-sapp/vulns.json"
  docker inspect -f '{{.State.Running}}' "$MOCK_SAPP" 2>/dev/null | grep -q true && return
  docker rm -f "$MOCK_SAPP" >/dev/null 2>&1 || true
  docker run -d --name "$MOCK_SAPP" --network "$NETWORK" -v "$WORK/mock-sapp:/data" node:20-alpine node /data/server.js >/dev/null
}

# run_act with one retry when Docker itself dropped out mid-run (an infra blip, not a result).
run_act() {
  _run_act "$@" && return 0
  grep -q 'Cannot connect to the Docker daemon' "$(ls -t "$WORK"/logs/*.log | head -1)" || return 1
  log "Docker daemon blip — waiting for it and retrying once"
  local i; for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 5; done
  _run_act "$@"
}

# _run_act <event> <workflow file> <log name> [extra act args...]
_run_act() {
  need_secrets
  local event="$1" wf="$2" name="$3" logf; shift 3
  logf="$WORK/logs/$(date +%Y%m%d-%H%M%S)-$name.log"
  ensure_mock_sapp
  mkdir -p "$COMPOSER_CACHE_HOST"
  docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1 || \
    docker build -q -t "$RUNNER_IMAGE" -f "$HERE/runner.Dockerfile" "$HERE" >&2
  local maps=() m
  while read -r m; do [ -n "$m" ] && maps+=(--local-repository "$m"); done <<< "$UNDER_TEST
$(mirror_actions)"
  log "act $event $wf → $logf"
  # Secrets go by name only (-s NAME reads the env), so no value lands on a command line.
  ( cd "${HARNESS_SRC:-$SRC}" && \
    SAUCAL_SATIS_KEY="$SAUCAL_SATIS_KEY" PRODUCTION_SSH_PASS="${PRODUCTION_SSH_PASS:-$(site_pass)}" CI_BOT_TOKEN="$(gh auth token)" GITHUB_TOKEN="$(gh auth token)" SAPP_VULNS_KEY=harness-mock \
    act "$event" -W ".github/workflows/$wf" \
      -P "ubuntu-latest=$RUNNER_IMAGE" --pull=false \
      --artifact-server-path "$WORK/artifacts" \
      --network "$NETWORK" --var-file "${HARNESS_VARS:-$WORK/vars}" \
      --container-options "-v $COMPOSER_CACHE_HOST:/root/.cache/composer" \
      -s PRODUCTION_SSH_PASS -s CI_BOT_TOKEN -s GITHUB_TOKEN -s SAUCAL_SATIS_KEY -s SAPP_VULNS_KEY \
      "${maps[@]}" "$@" ) 2>&1 | perl -MTime::HiRes=time -pe 'BEGIN{$|=1;$s=time} printf "%7.1f ", time-$s' | tee "$logf" | grep -E '✅|❌|::error|Job (succeeded|failed)' >&2 || true
  grep -q '🏁  Job succeeded' "$logf" && ! grep -q '🏁  Job failed' "$logf"
}

# deploy [--force]: --force is Deploy's workflow_dispatch with disable-consistency-check, the
# same way a real first deploy onto an existing host (onboarding) skips the pre-push guard.
cmd_deploy() {
  git -C "$SRC" pull -q --ff-only
  if [ "${1:-}" = --force ]; then
    run_act workflow_dispatch deployment.yml deploy-forced --input disable-consistency-check=true
  else
    # A real push payload: Deploy skips on '[skip deploy]' in head_commit.message, which act's
    # default payload leaves empty (so the skip would never be exercised).
    local ev="$WORK/push-event.json"
    git -C "$SRC" log -1 --format=%B | python3 -c 'import json,sys; print(json.dumps({"ref":"refs/heads/main","head_commit":{"message":sys.stdin.read()}}))' > "$ev"
    run_act push deployment.yml deploy --eventpath "$ev"
    # Deploy's follow-up check dispatch reaches real GitHub, where Actions is off: the run sits queued
    # (uncancellable, undeletable) until GitHub drops it after 24h. Inert — nothing runs.
  fi
}
cmd_check()  { git -C "$SRC" pull -q --ff-only; run_act schedule consistency-check.yml check; }

# Run a command on the "production" host as the deploy user, e.g. `harness.sh server wp plugin list`.
cmd_server() { docker exec -u www-data -w "/apps/$SLUG/public_html" "docker-environment-site-$SLUG-1" "$@"; }

# push_orphan <dir> <repo> <branch> <message>: commit <dir> as a parentless commit and force it onto <branch>.
push_orphan() {
  local dir="$1" repo="$2" branch="$3" msg="$4"
  git -C "$dir" init -q -b "$branch"
  git -C "$dir" add -A
  git -C "$dir" -c user.name=harness -c user.email=harness@saucal.com commit -qm "$msg"
  git -C "$dir" push -q -f "https://github.com/$repo.git" "HEAD:refs/heads/$branch"
}

# delete_branches_except <repo> <keep...>: drop every other branch (closes PRs whose head goes).
delete_branches_except() {
  local repo="$1" b; shift
  for b in $(gh api "repos/$repo/branches" --paginate -q '.[].name'); do
    [[ " $* " == *" $b "* ]] && continue
    gh api -X DELETE "repos/$repo/git/refs/heads/$b" >/dev/null
  done
}

reset_repos() {
  log "Resetting $REPO: main = fresh seed from e2e/fixture, no other branches"
  rm -rf "$SRC"; cp -R "$HERE/fixture" "$SRC"
  push_orphan "$SRC" "$REPO" main "Seed from e2e fixture"
  git -C "$SRC" remote add origin "https://github.com/$REPO.git"
  git -C "$SRC" fetch -q origin && git -C "$SRC" branch -q -u origin/main
  gh api -X PATCH "repos/$REPO" -f default_branch=main >/dev/null
  delete_branches_except "$REPO" main

  # The default branch can't be deleted, so park it on a placeholder: every run then starts
  # with no <ref>-built branch, i.e. no previous built commit, exactly like a first deploy.
  log "Resetting $BUILT: only a placeholder default branch"
  local ph="$WORK/placeholder"; rm -rf "$ph"; mkdir -p "$ph"
  echo "Harness placeholder — built branches are created by deploys." > "$ph/README.md"
  push_orphan "$ph" "$BUILT" harness-placeholder "Harness placeholder"
  gh api -X PATCH "repos/$BUILT" -f default_branch=harness-placeholder >/dev/null
  delete_branches_except "$BUILT" harness-placeholder
}

cmd_down() {
  mkdir -p "$WORK"
  for r in "$REPO" "$BUILT"; do gh repo view "$r" >/dev/null 2>&1 || die "$r missing — nothing to reset"; done
  reset_repos
  if [ -d "$DWP/data/apps/$SLUG" ]; then log "Purging docker-wp site $SLUG"; docker-wp-delete-site "$SLUG" --purge >&2; fi
  docker rm -f "$MOCK_SAPP" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}

# target <owner/repo>: run that repo's own consistency check (a real host, its real drift) with the
# actions under test, auto-merge off: reconcile opens/updates its PR, nothing merges or deploys.
# The SSH password comes from the environment only, e.g.
#   PRODUCTION_SSH_PASS="$(op item get … --fields label=password --reveal)" ./harness.sh target saucal/ci-test-ftp
cmd_target() {
  local repo="${1:?usage: target <owner/repo>}" dir="$WORK/target"
  [ -n "${PRODUCTION_SSH_PASS:-}" ] || die "set PRODUCTION_SSH_PASS in the environment (never on the command line)"
  mkdir -p "$WORK/logs"; rm -rf "${dir:?}"; mkdir -p "$dir"
  git clone -q "https://github.com/$repo.git" "$dir/src"
  # The repo's own variables (multi-line values escaped for act's dotenv parser), then the run's own.
  gh api "repos/$repo/actions/variables" --paginate -q '.variables[] | "\(.name)=\(.value | @json)"' > "$dir/vars"
  { echo "SAUCAL_CONSISTENCY_RECONCILE=1"; echo "SAUCAL_CONSISTENCY_RECONCILE_MERGE=0"; echo "PHP_VERSION=8.3"
    echo "SAPP_SERVER=http://$MOCK_SAPP:8080"; } >> "$dir/vars"
  log "Consistency check of $repo with the actions under test (auto-merge off)"
  HARNESS_SRC="$dir/src" HARNESS_VARS="$dir/vars" run_act schedule consistency-check.yml target-check || true
  grep -E 'Reconcile outcome|Verified [0-9]|held for a human|^ *[0-9.]+ .*\|   - |::warning::|::error::|Opened PR|Updated PR' "$(ls -t "$WORK"/logs/*-target-check.log | head -1)" \
    | grep -v '🐳' | sed -E 's/^ *[0-9.]+ \[[^]]*\] *//' | cut -c1-220 | head -40
}

# What the baseline depends on: the fixture, the runner image, the WP version and the action branches
# under test that build it (not the consistency-check action itself, which only runs on drift).
snapshot_key() {
  { cat "$HERE/runner.Dockerfile"; echo "$WP_VERSION"
    find "$HERE/fixture" -type f -print0 | sort -z | xargs -0 shasum
    local m path; while IFS= read -r m; do path="${m#*=}"; [ -n "$m" ] || continue
      [ "$path" = "$(cd "$HERE/.." && pwd)" ] && continue
      echo "${m%%=*} $(git -C "$path" rev-parse HEAD) $(git -C "$path" status --porcelain | shasum)"
    done <<< "$UNDER_TEST"; } | shasum | cut -c1-16
}

set_ref() { # set_ref <repo> <branch> <sha>: point a branch at a commit, creating it if needed
  gh api -X PATCH "repos/$1/git/refs/heads/$2" -f sha="$3" -F force=true >/dev/null 2>&1 \
    || gh api -X POST "repos/$1/git/refs" -f ref="refs/heads/$2" -f sha="$3" >/dev/null
}

# snapshot: cache the green baseline `up` just built, so `reset` restores it instead of rebuilding.
cmd_snapshot() {
  log "Caching the baseline in $SNAP"
  rm -rf "${SNAP:?}"; mkdir -p "$SNAP"
  rsync -a "$DWP/data/apps/$SLUG/public_html/" "$SNAP/public_html/"
  cmd_server wp db export - > "$SNAP/db.sql"
  git -C "$SRC" rev-parse origin/main > "$SNAP/src-sha"
  gh api "repos/$BUILT/git/ref/heads/main-built" -q .object.sha > "$SNAP/built-sha"
  cp "$WORK/ssh_pass" "$WORK/vars" "$SNAP/"
  # Pinned on GitHub too, so resetting main / main-built by ref never strands the baseline commits.
  set_ref "$REPO" harness-snapshot "$(cat "$SNAP/src-sha")"
  set_ref "$BUILT" harness-snapshot "$(cat "$SNAP/built-sha")"
  snapshot_key > "$SNAP/key"
}

# reset [--fresh]: back to the cached baseline in seconds (site files, DB, both repos, no PRs);
# rebuilt with down + up only when what it depends on changed, or with --fresh.
cmd_reset() {
  if [ "${1:-}" = --fresh ] || [ ! -f "$SNAP/key" ] || [ "$(cat "$SNAP/key")" != "$(snapshot_key)" ] || [ ! -d "$DWP/data/apps/$SLUG" ]; then
    log "No usable cached baseline: rebuilding it (down + up)"
    if gh repo view "$REPO" >/dev/null 2>&1; then cmd_down; fi
    cmd_up
    return
  fi
  log "Restoring the cached baseline"
  mkdir -p "$WORK/logs"; rm -f "$WORK"/logs/*.log
  cp "$SNAP/ssh_pass" "$SNAP/vars" "$WORK/"
  local n
  for n in $(gh pr list -R "$REPO" --state open --json number -q '.[].number'); do gh pr close "$n" -R "$REPO" >/dev/null; done
  set_ref "$REPO" main "$(cat "$SNAP/src-sha")"
  delete_branches_except "$REPO" main harness-snapshot
  set_ref "$BUILT" main-built "$(cat "$SNAP/built-sha")"
  delete_branches_except "$BUILT" harness-placeholder main-built harness-snapshot
  [ -d "$SRC/.git" ] || git clone -q "https://github.com/$REPO.git" "$SRC"
  git -C "$SRC" fetch -q origin && git -C "$SRC" checkout -q -B main origin/main && git -C "$SRC" clean -fdq
  rsync -a --delete "$SNAP/public_html/" "$DWP/data/apps/$SLUG/public_html/"
  docker exec -i -u www-data -w "/apps/$SLUG/public_html" "docker-environment-site-$SLUG-1" wp db import - < "$SNAP/db.sql" >/dev/null
  ensure_mock_sapp; echo '{}' > "$WORK/mock-sapp/vulns.json"
  echo green > "$WORK/state"
}

# suite [scenario...]: each scenario from the cached baseline (default: all of them).
cmd_suite() {
  local s list=("$@")
  [ ${#list[@]} -gt 0 ] || mapfile -t list < <(ls "$HERE/scenarios" | sed 's/\.sh$//')
  for s in "${list[@]}"; do cmd_reset; cmd_scenario "$s"; done
}

# baseline: back to a green, PR-free state built from main (close PRs, drop branches, forced deploy).
cmd_baseline() {
  local n
  for n in $(gh pr list -R "$REPO" --state open --json number -q '.[].number'); do gh pr close "$n" -R "$REPO" >/dev/null; done
  delete_branches_except "$REPO" main
  echo '{}' > "$WORK/mock-sapp/vulns.json" 2>/dev/null || true
  cmd_deploy --force >/dev/null 2>&1 || die "baseline deploy failed"
  cmd_check >/dev/null 2>&1 || die "baseline check not green"
  echo green > "$WORK/state"
}

# shellcheck source=/dev/null
. "$HERE/scenario-lib.sh"

case "${1:-}" in
  up|check|down|baseline|snapshot) "cmd_$1" ;;
  reset) shift; cmd_reset "$@" ;;
  target) shift; cmd_target "$@" ;;
  suite) shift; cmd_suite "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  server) shift; cmd_server "$@" ;;
  scenario) shift; for s in "$@"; do cmd_scenario "$s"; done ;;
  *) echo "usage: $0 up|reset [--fresh]|suite [name...]|baseline|deploy [--force]|check|server <cmd...>|scenario <name...>|snapshot|down" >&2; exit 2 ;;
esac
