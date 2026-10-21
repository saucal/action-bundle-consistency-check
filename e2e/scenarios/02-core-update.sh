DESCRIPTION="WordPress core updated on the server 6.9.1 → 6.9.4 (writable core)"
drift() { server wp core update --version=6.9.4 --force; }
expect() { expect_merged; expect_composer extra.wordpress-core 6.9.4; expect_final green; }
