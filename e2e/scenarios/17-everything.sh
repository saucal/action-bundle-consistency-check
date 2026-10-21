DESCRIPTION="Everything in one sync: bump, pin lift, core update, FTP hotfix, committed-plugin edit, clean addition, vulnerable addition, private plugin, junk file"
VULNS='{"classic-editor":[{"id":"wf-demo-1","cve":"CVE-2026-0001","title":"Demo: stored XSS","fixed_in":"9.9.9"}]}'
# Starts from the fixture (./harness.sh up): duplicate-post 4.5, wordpress-importer pinned 0.9.5,
# eps-301-redirects 2.85, core 6.9.1.
drift() {
  server wp plugin update duplicate-post --version=4.6                       # bump
  server wp plugin update wordpress-importer --version=0.9.6                 # pin lift
  server wp core update --version=6.9.4 --force                              # core follow
  server sh -c 'echo "// everything hotfix" >> wp-content/plugins/eps-301-redirects/eps-301-redirects.php'   # patch
  server sh -c 'echo "// everything tweak" >> wp-content/plugins/custom-plugin/custom-plugin.php'           # tracked
  server wp plugin install hello-dolly                                       # clean addition
  server wp plugin install classic-editor                                    # vulnerable addition → held
  server sh -c 'mkdir -p wp-content/plugins/acme-private && printf "<?php\n/**\n * Plugin Name: Acme Private\n * Version: 1.0.0\n */\nadd_action( \"init\", function () {} );\n" > wp-content/plugins/acme-private/acme-private.php'  # VEND → held
  server sh -c 'echo 1 > wp-content/cron-warm.tick'                          # junk → reported
}
expect() {
  expect_merged; expect_log 'Mixed heal'
  expect_merged_files composer.lock patches/eps-301-redirects.patch plugins/custom-plugin/custom-plugin.php
  expect_merged_lacks plugins/acme-private/acme-private.php
  expect_lock wpackagist-plugin/duplicate-post 4.6
  expect_composer require.wpackagist-plugin/wordpress-importer '>=0.9.6'
  expect_composer extra.wordpress-core 6.9.4
  expect_composer require.wpackagist-plugin/hello-dolly '>=1.7.2'
  expect_composer require.wpackagist-plugin/classic-editor None
  expect_patch_locked wpackagist-plugin/eps-301-redirects patches/eps-301-redirects.patch
  expect_deploy_log 'Success - Main Dispatch the consistency check'
  expect_review_pr composer.json plugins/acme-private/acme-private.php
  expect_final red
}
