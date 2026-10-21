DESCRIPTION="extra.wordpress-core was dropped from the repo; core is writable, so a heal brings it back"
prepare() {
  # Drop the line the way engineers did (lock hash refreshed), then make that the baseline.
  git -C "$SRC" pull -q --ff-only
  ( cd "$SRC" && composer config --unset extra.wordpress-core && composer update --lock --no-install -q \
    && git add composer.json composer.lock && git -c user.name=harness -c user.email=harness@saucal.com commit -qm "Drop extra.wordpress-core" && git push -q origin main )
  cmd_deploy --force >/dev/null 2>&1; cmd_check >/dev/null 2>&1
}
drift() { server wp plugin update duplicate-post --version=4.6; }
expect() { expect_merged; expect_composer extra.wordpress-core "$(server wp core version)"; expect_lock wpackagist-plugin/duplicate-post 4.6; expect_final green; }
