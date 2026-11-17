'use strict';
// Stands in for signature-base's YARA rules in tests (no python or network): "matches" only the
// textbook loader line the tests already use, as WEBSHELL_PHP_Generic_Eval did when measured.
const fs = require('fs');
const yara = require('../../lib/yara');

const TEXTBOOK = 'ev' + "al(base64_decode($_POST['x']));";
const MATCH = [{ rule: 'WEBSHELL_PHP_Generic_Eval', author: 'Arnim Rupp (https://github.com/ruppde)' }];
const hit = (text) => (String(text).includes(TEXTBOOK) ? MATCH : []);

const stub = ({ files, buffers }) => ({ files: files.map((f) => hit(fs.readFileSync(f, 'utf8'))), buffers: buffers.map(hit) });
yara.setRunner(stub); // preloaded by the npm test scripts (--require)
module.exports = { TEXTBOOK, MATCH, stub };
