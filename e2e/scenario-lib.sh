# Scenario runner for harness.sh (sourced). A scenario file (e2e/scenarios/<name>.sh) sets
# DESCRIPTION and optional VULNS (mock vulns/match data), and defines drift() (changes on the
# "production" host) and expect() (assertions on the outcome). The runner:
#   baseline (if needed) → drift → check (run 1) → if a PR was merged: commit deploy → check (run 2)
# then calls expect() with the facts below, and writes .work/examples/<name>.md.
#
# Facts: FINAL (green|red), RUN1_PR / RUN1_PR_STATE / RUN1_PR_FILES, REVIEW_PR / REVIEW_PR_FILES
# (open PR left after the last run), RUN1_LOG, RUN2_LOG.

RESULTS="$WORK/scenario-results.md"

pr_files() { gh pr view "$1" -R "$REPO" --json files -q '[.files[].path] | join(" ")'; }

# Assertions: each prints and records one PASS/FAIL line.
_assert() { local ok="$1" what="$2" got="$3"
  if [ "$ok" = 1 ]; then echo "    PASS  $what"; echo "- ✅ $what" >> "$RESULTS"
  else echo "    FAIL  $what (got: $got)"; echo "- ❌ $what — got: $got" >> "$RESULTS"; SCENARIO_FAILED=1; fi; }
expect_final()        { _assert "$([ "$FINAL" = "$1" ] && echo 1)" "final check is $1" "$FINAL"; }
expect_merged()       { _assert "$([ "$RUN1_PR_STATE" = MERGED ] && echo 1)" "run 1 auto-merged a PR" "${RUN1_PR_STATE:-no PR}"; }
expect_not_merged()   { _assert "$([ "$RUN1_PR_STATE" != MERGED ] && echo 1)" "nothing auto-merged" "${RUN1_PR_STATE:-no PR}"; }
expect_merged_files() { local f; for f in "$@"; do _assert "$(grep -qw -- "$f" <<< "$RUN1_PR_FILES" && echo 1)" "merged PR contains $f" "$RUN1_PR_FILES"; done; }
expect_merged_lacks() { local f; for f in "$@"; do _assert "$(grep -qw -- "$f" <<< "$RUN1_PR_FILES" || echo 1)" "merged PR does not contain $f" "$RUN1_PR_FILES"; done; }
expect_review_pr()    { local f; _assert "$([ -n "$REVIEW_PR" ] && echo 1)" "a review PR is left open" "none"
                        for f in "$@"; do _assert "$(grep -qw -- "$f" <<< "$REVIEW_PR_FILES" && echo 1)" "review PR contains $f" "$REVIEW_PR_FILES"; done; }
expect_no_review_pr() { _assert "$([ -z "$REVIEW_PR" ] && echo 1)" "no review PR left open" "#$REVIEW_PR"; }
expect_deploy_log()   { _assert "$(grep -qE -- "$1" "${DEPLOY_LOG:-/dev/null}" && echo 1)" "commit deploy log shows /$1/" "not found"; }
expect_deploy_lacks() { _assert "$(grep -qE -- "$1" "${DEPLOY_LOG:-/dev/null}" || echo 1)" "commit deploy log does not show /$1/" "found"; }
expect_run1_pr_open() { _assert "$([ "$RUN1_PR_STATE" = OPEN ] && echo 1)" "run 1 left a PR open for review" "${RUN1_PR_STATE:-no PR}"; }
expect_pr_closed()    { local st; st="$(gh pr view "$RUN1_PR" -R "$REPO" --json state -q .state 2>/dev/null)"; _assert "$([ "$st" = CLOSED ] && echo 1)" "run 1's PR #$RUN1_PR was closed" "$st"; }
expect_branch_gone()  { _assert "$(gh api "repos/$REPO/git/refs/heads/$1" >/dev/null 2>&1 || echo 1)" "branch $1 was deleted" "still there"; }
# The built repo's lock (what the server is recorded to run), and a real Deploy of main afterwards.
expect_built_lock()   { local got; got="$(gh api "repos/$REPO-built/contents/composer.lock?ref=main-built" -q .content | base64 -d | python3 -c "import json,sys; print(next((p['version'] for p in json.load(sys.stdin)['packages'] if p['name']==sys.argv[1]), 'absent'))" "$1")"
                        _assert "$([ "$got" = "$2" ] && echo 1)" "built repo locks $1 at $2" "$got"; }
# Parity first: main's tip is a merge whose 1st parent is what the built repo was built from (as of
# run 1's commit deploy, before any later Deploy moves it), and whose 2nd parent is the undeployed tip.
expect_parity_first() { local tip p1 src; git -C "$SRC" fetch -q origin main; tip="$(git -C "$SRC" rev-parse origin/main)"
                        p1="$(git -C "$SRC" rev-parse "$tip^1" 2>/dev/null)"
                        src="$(gh api "repos/$REPO-built/commits/main-built" -q .commit.message | sed -n 's/^Build changes from \([0-9a-f]\{40\}\).*/\1/p')"
                        _assert "$([ -n "$p1" ] && [ "$p1" = "$src" ] && echo 1)" "main's 1st parent is the parity commit the built repo was built from" "1st parent ${p1:0:7}, built from ${src:0:7}"; }
expect_markers()      { local tip; tip="$(git -C "$SRC" rev-parse origin/main)"
                        _assert "$(git -C "$SRC" log -1 --format=%s "$tip" | grep -qF '[skip deploy]' && echo 1)" "main's tip says [skip deploy] (never deployed)" "$(git -C "$SRC" log -1 --format=%s "$tip")"
                        _assert "$(git -C "$SRC" log -1 --format=%s "$tip^1" | grep -qF '[commit only]' && echo 1)" "its parity parent says [commit only]" "$(git -C "$SRC" log -1 --format=%s "$tip^1")"; }
expect_deploy_ships() { git -C "$SRC" pull -q --ff-only; run_act workflow_dispatch deployment.yml deploy-manual >/dev/null 2>&1; local ok=$?
                        _assert "$([ $ok = 0 ] && echo 1)" "a normal Deploy of main afterwards succeeds" "failed"; }
expect_server_plugin(){ local got; got="$(server wp plugin get "$1" --field=version 2>/dev/null)"; got="${got:-absent}"; _assert "$([ "$got" = "$2" ] && echo 1)" "server runs $1 $2" "${got:-absent}"; }
expect_log()          { _assert "$(grep -qE -- "$1" "$RUN1_LOG" && echo 1)" "run 1 log shows /$1/" "not found"; }
expect_composer()     { local got; got="$(git -C "$SRC" show origin/main:composer.json | python3 -c "import json,sys; d=json.load(sys.stdin); v=d
for k in sys.argv[1].split('.'):
    v = v.get(k) if isinstance(v, dict) else None
print(v)" "$1")"; _assert "$([ "$got" = "$2" ] && echo 1)" "main composer.json $1 = $2" "$got"; }
expect_lock()         { local got; got="$(git -C "$SRC" show origin/main:composer.lock | python3 -c "import json,sys; print(next((p['version'] for p in json.load(sys.stdin)['packages'] if p['name']==sys.argv[1]), 'absent'))" "$1")"
                        _assert "$([ "$got" = "$2" ] && echo 1)" "main locks $1 at $2" "$got"; }
expect_main_file()    { local got; got="$(git -C "$SRC" show "origin/main:$1" 2>/dev/null)"; _assert "$(grep -qE -- "$2" <<< "$got" && echo 1)" "main $1 matches /$2/" "no match"; }
expect_main_lacks()   { local got; got="$(git -C "$SRC" show "origin/main:$1" 2>/dev/null)"; _assert "$(grep -qE -- "$2" <<< "$got" || echo 1)" "main $1 does not match /$2/" "matched"; }
# expect_patch_locked <package> <patch path>: registered in extra.patches, its sha256 in
# patches.lock.json matches the file, and main's composer.lock passes composer validate --check-lock.
expect_patch_locked() { local pkg="$1" pf="$2" tmp; tmp="$(mktemp -d)"
  git -C "$SRC" fetch -q origin && git -C "$SRC" archive origin/main composer.json composer.lock patches.lock.json "$pf" | tar -x -C "$tmp" 2>/dev/null
  local reg sha file_sha; reg="$(python3 -c "import json,sys; e=json.load(open('$tmp/composer.json')).get('extra',{}).get('patches',{}).get(sys.argv[1],[]); print(' '.join(x['url'] for x in e))" "$pkg")"
  sha="$(python3 -c "import json,sys; e=json.load(open('$tmp/patches.lock.json'))['patches'].get(sys.argv[1],[]); print(' '.join(x['sha256'] for x in e))" "$pkg" 2>/dev/null)"
  file_sha="$(shasum -a 256 "$tmp/$pf" 2>/dev/null | cut -d' ' -f1)"
  _assert "$(grep -q "$pf" <<< "$reg" && echo 1)" "extra.patches registers $pf for $pkg" "$reg"
  _assert "$([ -n "$file_sha" ] && grep -qw "$file_sha" <<< "$sha" && echo 1)" "patches.lock.json sha256 matches $pf" "lock=$sha file=$file_sha"
  _assert "$( (cd "$tmp" && composer validate --no-check-publish --check-lock -q >/dev/null 2>&1) && echo 1)" "composer.lock is in sync with composer.json" "composer validate --check-lock failed"
  rm -rf "$tmp"; }
server()              { cmd_server "$@"; }

# The newest PR opened or updated since <pr number floor>.
newest_pr_since() { gh pr list -R "$REPO" --state all --json number,state -q "[.[] | select(.number > $1)] | sort_by(.number) | last | \"\(.number) \(.state)\""; }

write_example() {
  local name="$1" f="$WORK/examples/$1.md"; mkdir -p "$WORK/examples"
  {
    echo "# $name — $DESCRIPTION"; echo
    echo "**Final check:** $FINAL"; echo
    if [ -n "$RUN1_PR" ]; then
      echo "## Run 1 → PR #$RUN1_PR ($RUN1_PR_STATE)"; echo
      echo "Files: \`${RUN1_PR_FILES// /\`, \`}\`"; echo
      gh pr view "$RUN1_PR" -R "$REPO" --json title,body -q '"**" + .title + "**\n\n" + .body' | sed -n '1,40p'; echo
    else
      echo "## Run 1 → no PR"; echo
    fi
    echo '### Run 1 log (reconcile)'; echo; echo '```'
    grep -E "Mixed heal|Reconcile outcome|Verified|Self-heal: merged|Opened PR|Updated PR|Compromise signals|::warning|moved|no committable" "$RUN1_LOG" | grep -v '"url"' | sed -E 's/^.*\] *[|❗⚙ ]*//' | head -12; echo '```'; echo
    if [ -n "$REVIEW_PR" ]; then
      echo "## Left for review → PR #$REVIEW_PR"; echo
      echo "Files: \`${REVIEW_PR_FILES// /\`, \`}\`"; echo
      gh pr view "$REVIEW_PR" -R "$REPO" --json body -q .body | sed -n '1,25p'; echo
    fi
  } > "$f"
}

cmd_scenario() {
  local name="$1" file="$HERE/scenarios/$1.sh"
  [ -f "$file" ] || die "no scenario $file"
  ( set +e
    DESCRIPTION=""; VULNS='{}'; SCENARIO_FAILED=0
    drift() { :; }; expect() { :; }; prepare() { :; }
    # shellcheck source=/dev/null
    . "$file"
    log "SCENARIO $name — $DESCRIPTION"
    [ "$(cat "$WORK/state" 2>/dev/null)" = green ] || { log "  baseline"; cmd_baseline; }
    prepare   # repo-side setup that needs its own baseline (e.g. drop a composer line), optional
    echo "$VULNS" > "$WORK/mock-sapp/vulns.json"
    drift >/dev/null 2>&1
    echo dirty > "$WORK/state"

    local floor; floor="$(gh pr list -R "$REPO" --state all --json number -q 'map(.number) | max // 0')"
    log "  run 1"; cmd_check >/dev/null 2>&1; RUN1_LOG="$(ls -t "$WORK"/logs/*-check.log | head -1)"
    read -r RUN1_PR RUN1_PR_STATE <<< "$(newest_pr_since "$floor")"
    # A fast-forward merge (undeployed commits) is marked merged by GitHub a few seconds later.
    if [ "$RUN1_PR_STATE" = OPEN ] && grep -qxE 'behind|identical' <<< "$(gh api "repos/$REPO/compare/main...$(gh pr view "$RUN1_PR" -R "$REPO" --json headRefOid -q .headRefOid)" -q .status 2>/dev/null)"; then
      local i; for i in $(seq 12); do sleep 5; read -r RUN1_PR RUN1_PR_STATE <<< "$(newest_pr_since "$floor")"; [ "$RUN1_PR_STATE" = MERGED ] && break; done
    fi
    RUN1_PR_FILES=""; [ -n "$RUN1_PR" ] && RUN1_PR_FILES="$(pr_files "$RUN1_PR")"
    FINAL=red; RUN2_LOG=""; DEPLOY_LOG=""
    if declare -f resolve >/dev/null; then
      # The server is put right some other way (a deploy, a manual fix) before the next check.
      log "  resolve"; resolve >/dev/null 2>&1
      log "  run 2"
      if cmd_check >/dev/null 2>&1; then FINAL=green; fi
      RUN2_LOG="$(ls -t "$WORK"/logs/*-check.log | head -1)"
    elif [ "$RUN1_PR_STATE" = MERGED ]; then
      log "  commit deploy"; cmd_deploy >/dev/null 2>&1; DEPLOY_LOG="$(ls -t "$WORK"/logs/*-deploy.log | head -1)"
      log "  run 2"
      if cmd_check >/dev/null 2>&1; then FINAL=green; fi
      RUN2_LOG="$(ls -t "$WORK"/logs/*-check.log | head -1)"
    fi
    REVIEW_PR="$(gh pr list -R "$REPO" --state open --json number -q 'map(.number) | max // empty')"
    REVIEW_PR_FILES=""; [ -n "$REVIEW_PR" ] && REVIEW_PR_FILES="$(pr_files "$REVIEW_PR")"
    [ "$FINAL" = green ] && [ -z "$REVIEW_PR" ] && echo green > "$WORK/state"

    { echo; echo "### $name — $DESCRIPTION"; } >> "$RESULTS"
    expect
    write_example "$name"
    [ "$SCENARIO_FAILED" = 0 ] && log "  ✅ $name" || log "  ❌ $name (see $RESULTS)"
  )
}
