DESCRIPTION="Edit made on the server to custom-plugin (committed to the repo)"
drift() { server sh -c 'echo "// tweak made on the server" >> wp-content/plugins/custom-plugin/custom-plugin.php'; }
expect() { expect_merged; expect_merged_files plugins/custom-plugin/custom-plugin.php; expect_main_file plugins/custom-plugin/custom-plugin.php 'tweak made on the server'; expect_final green; }
