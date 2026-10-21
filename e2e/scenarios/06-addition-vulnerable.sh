DESCRIPTION="Merchant installs Classic Editor, and ServiceApp reports a known vulnerability at that version"
VULNS='{"classic-editor":[{"id":"wf-demo-1","cve":"CVE-2026-0001","title":"Demo: stored XSS","cvss_score":6.4,"fixed_in":"9.9.9"}]}'
drift() { server wp plugin install classic-editor; }
expect() { expect_not_merged; expect_review_pr composer.json; expect_log 'CVE-2026-0001'; expect_final red; }
