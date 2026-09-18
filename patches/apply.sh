#!/usr/bin/env bash
#
# apply.sh <penpot-checkout-dir>
#
# Applies the mobile-gestures patch on top of a pinned Penpot source checkout.
# Every file under ./frontend is copied over the matching path in the checkout
# (same relative layout as the penpot/penpot monorepo). Verified against the
# commit pinned in ./PENPOT_COMMIT — run from any directory.
#
# Usage:
#   ./patches/apply.sh /path/to/penpot-checkout

set -euo pipefail

PENPOT_DIR="${1:?usage: apply.sh <penpot-checkout-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$PENPOT_DIR/frontend" ]; then
  echo "error: '$PENPOT_DIR' does not look like a Penpot checkout (no frontend/)" >&2
  exit 1
fi

applied=0
while IFS= read -r src; do
  rel="${src#"$SCRIPT_DIR"/}"
  dest="$PENPOT_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  applied=$((applied + 1))
done < <(find "$SCRIPT_DIR/frontend" -type f)

if [ "$applied" -eq 0 ]; then
  echo "error: no patch files found under $SCRIPT_DIR/frontend" >&2
  exit 1
fi

# Sanity checks so a subtle upstream reshuffle cannot silently disable the
# gesture layer (the build still succeeds without it).
if ! grep -q "mobile-gestures" "$PENPOT_DIR/frontend/src/app/main/ui/workspace/viewport/hooks.cljs"; then
  echo "error: hooks.cljs does not reference mobile-gestures; patch layout mismatch" >&2
  exit 1
fi
if [ ! -f "$PENPOT_DIR/frontend/src/app/main/ui/workspace/viewport/mobile_gestures.cljs" ]; then
  echo "error: mobile_gestures.cljs missing after apply" >&2
  exit 1
fi

echo "applied $applied patched file(s) into $PENPOT_DIR"