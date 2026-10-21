DESCRIPTION="Server-written code in risky shapes waits for review: a file added to custom-plugin, and a script tag with an external URL added to it"
drift() {
  server sh -c 'printf "<?php\n// helper added on the server\n" > wp-content/plugins/custom-plugin/extra.php'                                     # new file
  server sh -c 'echo "?><script src=\"https://cdn.example/x.js\"></script><?php" >> wp-content/plugins/custom-plugin/custom-plugin.php'      # script tag + external URL
}
expect() { expect_not_merged; expect_log 'new-file'; expect_log 'adds-script-tag'; expect_review_pr plugins/custom-plugin/extra.php plugins/custom-plugin/custom-plugin.php; expect_final red; }
