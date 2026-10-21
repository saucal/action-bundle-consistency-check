DESCRIPTION="Combination: custom-plugin edit + a runtime junk file (.tick) — the edit heals, the junk is only reported"
drift() {
  server sh -c 'echo "// junk-run tweak" >> wp-content/plugins/custom-plugin/custom-plugin.php'
  server sh -c 'echo 1 > wp-content/cron-warm.tick'
}
expect() { expect_merged; expect_merged_files plugins/custom-plugin/custom-plugin.php; expect_no_review_pr; expect_final red; }
