DESCRIPTION="Hotfix edited over FTP into eps-301-redirects (composer-managed) at its installed version"
drift() { server sh -c 'echo "// hotfix applied on production" >> wp-content/plugins/eps-301-redirects/eps-301-redirects.php'; }
expect() { expect_merged; expect_patch_locked wpackagist-plugin/eps-301-redirects patches/eps-301-redirects.patch; expect_merged_files patches/eps-301-redirects.patch composer.json; expect_main_file patches/eps-301-redirects.patch 'hotfix applied on production'; expect_final green; }
