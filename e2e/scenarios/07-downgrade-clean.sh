DESCRIPTION="eps-301-redirects rolled back on the server 2.85 → 2.81 (no known vulnerabilities)"
drift() { server wp plugin install eps-301-redirects --version=2.81 --force; }
expect() { expect_merged; expect_lock wpackagist-plugin/eps-301-redirects 2.81; expect_final green; }
