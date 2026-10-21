"""Harness-only overlay of saucal/action-checkout-extended for act.

act (<=0.2.89) ignores an *expression* `continue-on-error` on a `uses:` step inside a
composite action (a literal `true` works), so a first deploy's "Checkout previous build
(if any)" fails the job locally while GitHub tolerates it. Make the flag literal and add a
guard that re-fails when the caller did not ask to continue — same behaviour as GitHub.
Usage: overlay-checkout-extended.py <action.yml>
"""
import re, sys

path = sys.argv[1]
src = open(path).read()
expr = "continue-on-error: ${{ inputs.continue-on-error == 'true' }}"
if src.count(expr) == 0:
    sys.exit(0)  # this branch has no expression flag — nothing to work around
assert src.count(expr) == 2, "checkout-extended changed shape; revisit the overlay"
out = []
for block in re.split(r"(?m)^(?=    - name: )", src):
    m = re.search(r"(?m)^      id: (checkout-(?:specific|current))$", block)
    if m and expr in block:
        block = block.replace(expr, "continue-on-error: true")
        block += (
            f"    - name: act overlay — re-fail {m.group(1)}\n"
            f"      if: ${{{{ steps.{m.group(1)}.outcome == 'failure' && inputs.continue-on-error != 'true' }}}}\n"
            "      shell: bash\n"
            "      run: exit 1\n\n"
        )
    out.append(block)
open(path, "w").write("".join(out))
