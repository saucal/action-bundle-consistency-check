'use strict';
const fs = require('fs');
const path = require('path');

// Signals of compromised PHP in content that came from the server with no registry behind it
// (patch residuals, adopted/tracked files, unknown components). Deliberately biased to flag:
// a hit only holds the heal for a human, it never deletes anything.
// [rule, regex, severity, phpOnly]. Only 'critical' holds a heal; 'warn' is listed for the reviewer.
// Measured against woocommerce/jetpack/elementor/wordfence: warn rules fire on legit code, critical don't.
const RULES = [
  ['eval-decoded', /\b(?:eval|assert|create_function)\s*\(\s*@?\s*(?:base64_decode|gzinflate|gzuncompress|str_rot13|hex2bin|urldecode)\s*\(/i, 'critical', true],
  ['eval-request', /\b(?:eval|assert|create_function)\s*\([^;]*\$_(?:GET|POST|REQUEST|COOKIE)\b/i, 'critical', true],
  ['eval-request', /\bpreg_replace\s*\(\s*["'][^"']*\/[a-zA-Z]*e[a-zA-Z]*["']\s*,[^;]*\$_(?:GET|POST|REQUEST|COOKIE)\b/, 'critical', true],
  ['shell-request', /(?<![\w>:$.])(?:shell_exec|passthru|system|exec|proc_open|popen|pcntl_exec)\s*\([^;]*\$_(?:GET|POST|REQUEST|COOKIE)\b/i, 'critical', true],
  ['shell-exec', /(?<![\w>:$.])(?:shell_exec|passthru|system|exec|proc_open|popen|pcntl_exec)\s*\(/i, 'warn', true],
  ['file-upload', /\bmove_uploaded_file\s*\(/i, 'warn', true],
  ['hides-users', /["'](?:pre_user_query|users_list_table_query_args|views_users)["']/, 'warn', true],
  ['hides-plugins', /["']all_plugins["']/, 'warn', true],
  ['creates-admin', /set_role\s*\(\s*["']administrator["']|["']role["']\s*=>\s*["']administrator["']/i, 'warn', true],
  ['encoded-blob', /[A-Za-z0-9+/=]{500,}/, 'warn', true],
];

const SCANNED_EXT = /\.(?:php\d?|phtml|inc|module|js|htaccess|ico|txt)$|(?:^|\/)\.htaccess$/i;
const PHP_EXT = /\.(?:php\d?|phtml|inc|module|ico|txt)$/i; // .ico/.txt: common hiding spots for included PHP

/**
 * @param {string} text
 * @param {string} [file] used to skip PHP-only rules on non-PHP files; omitted = treat as PHP
 * @returns {{rule:string, line:number, severity:'critical'|'warn'}[]} one hit per rule per line
 */
function scanText(text, file) {
  const php = !file || PHP_EXT.test(file);
  const hits = [];
  String(text).split('\n').forEach((l, i) => {
    const seen = new Set();
    for (const [rule, re, severity, phpOnly] of RULES) {
      if (phpOnly && !php) continue;
      if (!seen.has(rule) && re.test(l)) { seen.add(rule); hits.push({ rule, line: i + 1, severity }); }
    }
  });
  // Hiding users AND hiding plugins in one file is the stealth pattern of a planted backdoor.
  const has = (r) => hits.some((h) => h.rule === r);
  if (has('hides-users') && has('hides-plugins')) {
    hits.push({ rule: 'stealth', line: hits.find((h) => h.rule === 'hides-users').line, severity: 'critical' });
  }
  return hits;
}

/** The added side of a unified diff (what a patch would introduce). */
function addedLines(diff) {
  return String(diff).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n');
}

/**
 * Scan a file or a directory tree.
 * @returns {{file:string, rule:string, line:number, severity:string}[]} file paths relative to `base`
 */
function scanPath(target, base = target) {
  if (!fs.existsSync(target)) return [];
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) return [];
  if (st.isDirectory()) {
    return fs.readdirSync(target).flatMap((n) => scanPath(path.join(target, n), base));
  }
  // shortcut: files over 2 MB are skipped (minified bundles); upgrade if attackers hide there.
  if (!SCANNED_EXT.test(target) || st.size > 2 * 1024 * 1024) return [];
  const rel = path.relative(base, target) || path.basename(target);
  return scanText(fs.readFileSync(target, 'utf8'), target).map((h) => ({ file: rel, ...h }));
}

/** Scan only what a unified-diff patch file adds, per file (the published side has provenance). */
function scanPatch(patchPath) {
  if (!fs.existsSync(patchPath)) return [];
  return fs.readFileSync(patchPath, 'utf8').split(/^(?=diff --git )/m).flatMap((chunk) => {
    const file = (chunk.match(/^diff --git (?:a\/)?(\S+)/) || [])[1];
    return file ? scanText(addedLines(chunk), file).map((h) => ({ file, ...h })) : [];
  });
}

// Stricter rules for a DELTA (a patch or a tracked-file copy taken from the server). Deltas are
// small, so these are rare in legitimate edits and any hit holds the change for a human.
const DELTA_RULES = [
  ['eval', /\b(?:eval|assert|create_function)\s*\(/i],
  ['decode', /\b(?:base64_decode|gzinflate|gzuncompress|str_rot13|hex2bin|atob)\s*\(/i],
  ['globals', /\$GLOBALS\s*\[/],
  ['raw-input', /php:\/\/input/i],
  ['include-non-php', /\b(?:include|require)(?:_once)?\b[^;]*["'][^"';]*\.(?!php\b)[a-z0-9]{2,5}["']/i],
  ['dynamic-call', /\$\w+\(\$_(?:GET|POST|REQUEST|COOKIE|SERVER)\b/],
  ['chr-chain', /(?:chr\(\d+\)\.?){3,}/i],
  // Request data reaching new code is how a callback or variable-function shell gets its command.
  ['request-data', /\$_(?:GET|POST|REQUEST|COOKIE|FILES)\b|\$_SERVER\s*\[\s*['"]HTTP_/],
  ['remote-fetch', /\b(?:wp_(?:safe_)?remote_(?:get|post|request)|download_url|curl_exec|fsockopen)\s*\(|\b(?:file_get_contents|fopen)\s*\(\s*["']https?:/i],
  ['writes-file', /\b(?:file_put_contents|fwrite|fputs)\s*\(/i],
  // Markup a hotfix rarely adds and a skimmer always does: script/iframe tags, external URLs.
  ['adds-script-tag', /<\s*(?:script|iframe)\b/i],
  ['external-url', /\bhttps?:\/\//i],
];
// Must-use plugins run on every request without being activated: any change there waits for a human.
const MU_PLUGINS_RE = /(?:^|\/)(?:client-)?mu-plugins\//;
const BACKTICK_RE = /`[^`]+`/; // PHP shell exec; JS template literals are fine
const AUTH_CHECK_RE = /\b(?:current_user_can|wp_verify_nonce|check_admin_referer|check_ajax_referer|permission_callback|is_user_logged_in)\b/;
const RISKY_FILE_RE = /(?:^|\/)(?:package\.json|composer\.(?:json|lock)|\.htaccess|\.user\.ini|php\.ini|\.npmrc|\.pnpmfile\.cjs|pnpm-workspace\.yaml|\.yarnrc(?:\.yml)?)$|\.phar$/i;
// Verify and Deploy build with every secret, and pnpm/npm run scripts found in the tree: a delta to
// anything the toolchain can execute waits for a human. (On a store, JS is also the skimmer vector.)
const SCRIPT_FILE_RE = /\.(?:[cm]?js|jsx|tsx?|sh|bash)$/i;
const PHP_FILE_RE = /\.(?:php\d?|phtml|inc|module)$/i;

/** Join the added text and strip comments/whitespace, so split or spaced-out code reads as one. */
function normalize(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)(?:\/\/|#)[^\n]*/g, '$1').replace(/\s+/g, '');
}

/**
 * Assess a unified diff of server-derived changes before they may be merged unattended.
 * @param {string} diff
 * @returns {{critical:{file:string,rule:string,line:number}[], holds:{file:string,rule:string,line:number}[]}}
 *   clean (auto-mergeable) only when both are empty
 */
function assessDiff(diff) {
  const critical = [];
  const holds = [];
  for (const chunk of String(diff).split(/^(?=diff --git )/m)) {
    if (!/^diff --git /.test(chunk)) continue;
    // The name from the +++ line (--- for a deletion): whole rest of line, so spaces survive.
    const side = (re) => ((chunk.match(re) || [])[1] || '').replace(/\t.*$/, '');
    let file = side(/^\+\+\+ (?:b\/)?(.+)$/m);
    if (!file || file === '/dev/null') file = side(/^--- (?:a\/)?(.+)$/m);
    if (!file) file = (chunk.match(/^diff --git (?:a\/)?(\S+)/) || [])[1] || '(unknown)';
    const seen = new Set();
    const hold = (rule, line = 0) => { if (!seen.has(rule)) { seen.add(rule); holds.push({ file, rule, line }); } };
    // git still quotes names with quotes, backslashes or control characters: unreadable, so held.
    if (file.startsWith('"') || file === '(unknown)') hold('unreadable-path');
    if (/^Binary files /m.test(chunk) || /^GIT binary patch/m.test(chunk)) hold('binary');
    if (/^(?:new file mode|new mode) 120000/m.test(chunk)) hold('symlink');
    if (RISKY_FILE_RE.test(file)) hold('risky-file');
    if (SCRIPT_FILE_RE.test(file)) hold('script-file');
    // A file the server added (not an edit to one the repo already has): where a dropped backdoor shows up.
    if (/^new file mode /m.test(chunk) || /^--- \/dev\/null$/m.test(chunk)) hold('new-file');
    if (MU_PLUGINS_RE.test(file)) hold('must-use-plugin');

    const lines = chunk.split('\n');
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));

    // Every rule, on every text type: a delta is too small for the PHP-only noise filter to matter.
    for (const h of scanText(added.join('\n'))) {
      if (h.severity === 'critical') critical.push({ file, ...h });
      else hold(h.rule, h.line);
    }
    added.forEach((l, i) => {
      for (const [rule, re] of DELTA_RULES) if (re.test(l)) hold(rule, i + 1);
      if (PHP_FILE_RE.test(file) && BACKTICK_RE.test(l)) hold('backtick', i + 1);
    });
    const joined = normalize(added.join('\n'));
    for (const [rule, re] of DELTA_RULES) if (re.test(joined)) hold(rule);
    for (const [rule, re] of RULES) if (re.test(joined) && !seen.has(rule)) hold(rule);
    removed.forEach((l, i) => { if (AUTH_CHECK_RE.test(l)) hold('removes-auth-check', i + 1); });
  }
  return { critical, holds };
}

module.exports = { scanText, addedLines, scanPath, scanPatch, assessDiff, RULES };
