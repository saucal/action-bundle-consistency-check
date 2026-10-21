DESCRIPTION="Maintenance bumped duplicate-post to 4.6 ([skip deploy], not deployed) while the merchant rolled it back to 4.4 on the server: main keeps 4.6, the built repo records 4.4, and the Deploy ships 4.6"
prepare() {
  git -C "$SRC" pull -q --ff-only
  ( cd "$SRC" && composer update wpackagist-plugin/duplicate-post --with wpackagist-plugin/duplicate-post:4.6 --no-install -q \
    && git add composer.lock && git -c user.name=harness -c user.email=harness@saucal.com commit -qm "Update duplicate-post [skip deploy]" && git push -q origin main )
}
drift() { server wp plugin install duplicate-post --version=4.4 --force; }
expect() {
  expect_merged; expect_parity_first; expect_markers; expect_log 'not deployed yet'
  expect_lock wpackagist-plugin/duplicate-post 4.6; expect_built_lock wpackagist-plugin/duplicate-post 4.4; expect_final green
  expect_server_plugin duplicate-post 4.4; expect_deploy_ships; expect_server_plugin duplicate-post 4.6
}
