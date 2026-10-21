DESCRIPTION="Combination: custom-plugin edit + FTP hotfix in wordpress-importer + Hello Dolly removed"
drift() {
  server sh -c 'echo "// combo tweak" >> wp-content/plugins/custom-plugin/custom-plugin.php'
  server sh -c 'echo "// combo hotfix" >> wp-content/plugins/wordpress-importer/wordpress-importer.php'
  server wp plugin delete hello-dolly
}
expect() { expect_merged; expect_patch_locked wpackagist-plugin/wordpress-importer patches/wordpress-importer.patch; expect_merged_files plugins/custom-plugin/custom-plugin.php patches/wordpress-importer.patch composer.json; expect_composer require.wpackagist-plugin/hello-dolly None; expect_final green; }
