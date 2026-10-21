DESCRIPTION="A private plugin (on no registry) appears on the server"
drift() { server sh -c 'mkdir -p wp-content/plugins/acme-private && printf "<?php\n/**\n * Plugin Name: Acme Private\n * Version: 1.0.0\n */\nadd_action( \"init\", function () {} );\n" > wp-content/plugins/acme-private/acme-private.php'; }
expect() { expect_not_merged; expect_review_pr plugins/acme-private/acme-private.php; expect_log 'adopts server files'; expect_final red; }
