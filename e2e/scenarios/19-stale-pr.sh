DESCRIPTION="A held PR goes stale: the vulnerable plugin is removed from the server by hand, the next check is green, and self-heal closes the PR and deletes its branch"
VULNS='{"classic-editor":[{"id":"wf-demo-1","cve":"CVE-2026-0001","title":"Demo: stored XSS","fixed_in":"9.9.9"}]}'
drift()   { server wp plugin install classic-editor; }
resolve() { server wp plugin delete classic-editor; }
expect() {
  expect_run1_pr_open; expect_final green
  expect_pr_closed; expect_no_review_pr; expect_branch_gone reconciliation-main
}
