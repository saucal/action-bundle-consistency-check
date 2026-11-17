"""YARA pass for reconcile's scanner (see suspicious.js).

  yara-scan.py compile OUT RULE.yar...  compile once (licence-checked) into OUT
  yara-scan.py scan COMPILED            stdin {"files": [path], "buffers": [text]} ->
                                        stdout {"files": [[match]], "buffers": [[match]]}
A match is {"rule": name, "author": meta author}. Errors go to stderr with a non-zero exit.
"""
import json
import sys

import yara

EXTERNALS = {'filename': '', 'filepath': '', 'extension': '', 'filetype': ''}
# Only rules under the Detection Rule License 1.1 (signature-base's or SigmaHQ's copy of it).
DRL = ('Detection Rule License 1.1', 'github.com/SigmaHQ/Detection-Rule-License')


def compile_rules(out, files):
    rules = yara.compile(filepaths={str(i): f for i, f in enumerate(files)}, externals=EXTERNALS)
    for r in rules:
        lic = dict(r.meta).get('license')
        if lic is not None and not any(d in str(lic) for d in DRL):
            sys.exit(f'rule {r.identifier} is not under the Detection Rule License 1.1: {lic}')
    rules.save(out)


def matches(found):
    return [{'rule': m.rule, 'author': str(m.meta.get('author', ''))} for m in found]


def scan(compiled):
    rules = yara.load(compiled)
    req = json.load(sys.stdin)
    print(json.dumps({
        'files': [matches(rules.match(p, externals=EXTERNALS, timeout=60)) for p in req.get('files', [])],
        'buffers': [matches(rules.match(data=b.encode('utf-8', 'surrogatepass'), externals=EXTERNALS, timeout=60)) for b in req.get('buffers', [])],
    }))


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'compile' and len(sys.argv) > 3:
        compile_rules(sys.argv[2], sys.argv[3:])
    elif cmd == 'scan' and len(sys.argv) == 3:
        scan(sys.argv[2])
    else:
        sys.exit(__doc__)
