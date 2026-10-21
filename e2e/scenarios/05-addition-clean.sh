DESCRIPTION="Merchant installs Hello Dolly (no known vulnerabilities)"
drift() { server wp plugin install hello-dolly; }
expect() { expect_merged; expect_composer require.wpackagist-plugin/hello-dolly '>=1.7.2'; expect_final green; }
