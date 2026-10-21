DESCRIPTION="Pinned wordpress-importer (0.9.5) updated on the server to 0.9.6"
drift() { server wp plugin update wordpress-importer --version=0.9.6; }
expect() { expect_merged; expect_composer require.wpackagist-plugin/wordpress-importer '>=0.9.6'; expect_lock wpackagist-plugin/wordpress-importer 0.9.6; expect_final green; }
