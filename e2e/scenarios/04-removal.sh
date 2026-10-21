DESCRIPTION="Merchant deletes duplicate-post on the server"
drift() { server wp plugin delete duplicate-post; }
expect() { expect_merged; expect_composer require.wpackagist-plugin/duplicate-post None; expect_lock wpackagist-plugin/duplicate-post absent; expect_final green; }
