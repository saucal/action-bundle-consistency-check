DESCRIPTION="Combination: custom-plugin edit (clean) + Classic Editor installed with a known vulnerability"
VULNS='{"classic-editor":[{"id":"wf-demo-1","cve":"CVE-2026-0001","title":"Demo: stored XSS","fixed_in":"9.9.9"}]}'
drift() {
  server sh -c 'echo "// split tweak" >> wp-content/plugins/custom-plugin/custom-plugin.php'
  server wp plugin install classic-editor
}
expect() { expect_merged; expect_merged_files plugins/custom-plugin/custom-plugin.php; expect_merged_lacks composer.json; expect_log 'Mixed heal'; expect_review_pr composer.json; expect_final red; }
