'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Parse a WordPress header block (plugin main file or theme style.css).
 * @param {string} content
 * @returns {{version:string|null, name:string|null}}
 */
function parseHeader(content) {
  const ver = content.match(/^[ \t\/*#@]*Version:\s*(.+?)\s*(?:\*\/)?\s*$/im);
  const name = content.match(/^[ \t\/*#@]*(?:Plugin Name|Theme Name):\s*(.+?)\s*(?:\*\/)?\s*$/im);
  return { version: ver ? ver[1].trim() : null, name: name ? name[1].trim() : null };
}

/** Scan a plugin directory for the first .php file carrying a Version header. */
function pluginVersion(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.php')) continue;
    const h = parseHeader(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (h.version) return h;
  }
  return null;
}

/** Read a theme's style.css header. */
function themeVersion(dir) {
  const css = path.join(dir, 'style.css');
  if (!fs.existsSync(css)) return null;
  return parseHeader(fs.readFileSync(css, 'utf8'));
}

module.exports = { parseHeader, pluginVersion, themeVersion };
