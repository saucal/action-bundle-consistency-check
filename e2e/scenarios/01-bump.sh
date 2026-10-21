DESCRIPTION="Merchant updates duplicate-post 4.5 → 4.6 on the server"
drift() { server wp plugin update duplicate-post --version=4.6; }
expect() { expect_merged; expect_merged_files composer.lock; expect_merged_lacks patches.lock.json; expect_lock wpackagist-plugin/duplicate-post 4.6; expect_final green; expect_no_review_pr; expect_deploy_lacks 'Dispatch the consistency check'; }
