DESCRIPTION="Commits not deployed yet ([skip deploy] adds Hello Dolly) while core drifts on the server: the heal merges next to them, and their Deploy then goes through"
prepare() {
  git -C "$SRC" pull -q --ff-only
  ( cd "$SRC" && composer require wpackagist-plugin/hello-dolly:'>=1.7' --no-install -q \
    && git add composer.json composer.lock && git -c user.name=harness -c user.email=harness@saucal.com commit -qm "Add Hello Dolly [skip deploy]" && git push -q origin main )
}
drift() { server wp core update --version=6.9.4 --force; }
expect() {
  expect_merged; expect_parity_first; expect_markers; expect_composer extra.wordpress-core 6.9.4; expect_composer require.wpackagist-plugin/hello-dolly '>=1.7'
  expect_built_lock wpackagist-plugin/hello-dolly absent; expect_final green
  expect_server_plugin hello-dolly absent; expect_deploy_ships; expect_server_plugin hello-dolly "$(git -C "$SRC" show origin/main:composer.lock | python3 -c "import json,sys; print(next(p['version'] for p in json.load(sys.stdin)['packages'] if p['name']=='wpackagist-plugin/hello-dolly'))")"
}
