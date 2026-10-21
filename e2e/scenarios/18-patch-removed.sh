DESCRIPTION="A patched plugin is back to pristine on the server: the patch must leave the repo, and the build must drop it"
prepare() {
  # A hotfix becomes a patch the way it does for real: self-heal holds it, a person merges the PR, and
  # the next check commits the build (source already carries the patch, only the built repo is behind).
  server sh -c 'echo "// hotfix to be removed" >> wp-content/plugins/eps-301-redirects/eps-301-redirects.php'
  cmd_check >/dev/null 2>&1
  local pr; pr="$(gh pr list -R "$REPO" --state open --json number -q '.[0].number')"
  [ -n "$pr" ] && gh pr merge "$pr" -R "$REPO" --merge >/dev/null
  git -C "$SRC" pull -q --ff-only
  cmd_check >/dev/null 2>&1; cmd_check >/dev/null 2>&1
}
drift() { server wp plugin install eps-301-redirects --version="$(server wp plugin get eps-301-redirects --field=version)" --force; }
expect() { expect_merged; expect_composer extra.patches None; expect_main_lacks patches/eps-301-redirects.patch '.'; expect_final green; }
