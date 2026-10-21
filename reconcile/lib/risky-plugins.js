'use strict';

// Plugins that hand whoever is logged in (or whoever compromised the site) code
// execution, raw file or database access, or a way to impersonate users. Free (wpackagist) and
// pro (SatisPress, saucal/<slug>) slugs alike. Self-heal never adds one of these on its own: a new
// require for a listed slug waits for a human. One the repo already requires keeps updating
// automatically like any other plugin.
const CATEGORIES = {
  'file manager': [
    'wp-file-manager', 'file-manager-advanced', 'file-manager', 'filester', 'fileorganizer',
    'advanced-file-manager', 'wpide', 'wp-filemanager', 'wp-file-manager-pro', 'file-manager-advanced-shortcode',
  ],
  'code snippets / code execution': [
    'code-snippets', 'insert-headers-and-footers', 'header-footer-code-manager', 'woody-ad-snippets',
    'insert-php', 'php-code-widget', 'php-everywhere', 'custom-css-js', 'post-snippets', 'shortcoder',
    'scripts-n-styles', 'head-footer-code', 'header-and-footer-scripts', 'wp-headers-and-footers',
    'wp-console', 'code-snippets-pro', 'wpcode-premium', 'custom-css-js-pro',
    'wp-all-import-pro', // its function editor runs arbitrary PHP
  ],
  'file editor': ['string-locator', 'theme-editor', 'wp-editor'],
  'database admin': ['wp-phpmyadmin-extension', 'ari-adminer', 'wp-dbmanager'],
  'site export / migration': [
    'wp-migrate-db', 'wp-migrate-db-pro', 'wpvivid-backup-pro', 'wpe-site-migration', 'all-in-one-wp-migration',
    'duplicator', 'duplicator-pro',
  ],
  'login bypass / impersonation': ['temporary-login-without-password', 'user-switching', 'login-shop-as-customer-woocommerce'],
};

const BY_SLUG = new Map(Object.entries(CATEGORIES).flatMap(([cat, slugs]) => slugs.map((s) => [s, cat])));

/** @returns {string|null} the risk category of a wpackagist or SatisPress plugin package, or null */
function riskyPluginCategory(composerPackage) {
  const m = /^(?:wpackagist-plugin|saucal)\/(.+)$/.exec(composerPackage || '');
  return (m && BY_SLUG.get(m[1])) || null;
}

module.exports = { riskyPluginCategory, CATEGORIES };
