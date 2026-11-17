'use strict';
// The real YARA pass: runs only where yara-python is installed (YARA_PYTHON, else python3), and then
// downloads the pinned signature-base rules. Everything else in the suite uses the stub.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const yara = require('../lib/yara');
const { assessDiff } = require('../lib/suspicious');
const { TEXTBOOK, stub } = require('./helpers/yara-stub');

const python = process.env.YARA_PYTHON || 'python3';
let skip = false;
try { execFileSync(python, ['-I', '-c', 'import yara'], { stdio: 'ignore' }); } catch { skip = 'yara-python not installed'; }

test('real YARA: the pinned rules download, verify, compile, and flag the textbook line with its author', { skip }, async () => {
  yara.setRunner(null);
  try {
    const t = Date.now();
    assert.strictEqual(await yara.prepare({ fetch, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'yara-')), python }), null);
    const r = yara.scan({ buffers: ['<?php\n' + TEXTBOOK + '\n', '<?php echo esc_html( $title );\n'] });
    assert.ok(r.buffers[0].some((m) => m.rule === 'WEBSHELL_PHP_Generic_Eval' && /Arnim Rupp/.test(m.author)), JSON.stringify(r));
    assert.deepStrictEqual(r.buffers[1], []);
    const diff = ['diff --git a/x.php b/x.php', '--- a/x.php', '+++ b/x.php', '@@ -1 +1,2 @@', '+<?php', '+' + TEXTBOOK].join('\n');
    assert.ok(assessDiff(diff).critical.some((h) => h.rule === 'yara:WEBSHELL_PHP_Generic_Eval'));
    console.log(`prepare + scans: ${Date.now() - t} ms`);
  } finally { yara.setRunner(stub); }
});

test('real YARA: a rule under another licence is refused at compile time', { skip }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yara-'));
  fs.writeFileSync(path.join(d, 'r.yar'), 'rule other_licence { meta: license = "CC BY-NC 4.0" condition: false }\n');
  assert.throws(() => execFileSync(python, ['-I', path.join(__dirname, '../lib/yara-scan.py'), 'compile', path.join(d, 'out'), path.join(d, 'r.yar')], { stdio: 'pipe' }),
    (e) => /not under the Detection Rule License 1\.1/.test(String(e.stderr)));
});
