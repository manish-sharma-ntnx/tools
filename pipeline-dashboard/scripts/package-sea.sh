#!/usr/bin/env bash
#
# Build a single portable executable for the MSP Pipeline Dashboard using Node's
# Single Executable Application (SEA) feature. The produced binary bundles the
# Node runtime + app; it runs on any matching-arch Linux box with NO Node
# installed and NO dependency on the system's (old) /usr/bin/node.
#
# Usage:  bash scripts/package-sea.sh
# Output: dist/msp-pipeline-dashboard   (copy this file anywhere and run it)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NODE_BIN="${NODE_BIN:-$(command -v node)}"
echo "[sea] using node: $NODE_BIN ($($NODE_BIN -v))"

# Require Node >= 20 for stable SEA support.
MAJOR="$($NODE_BIN -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 20 ]; then
  echo "[sea] ERROR: need Node >= 20 to build the SEA (found $($NODE_BIN -v))." >&2
  echo "[sea] Point NODE_BIN at a modern node, e.g. NODE_BIN=/path/to/node bash scripts/package-sea.sh" >&2
  exit 1
fi

echo "[sea] 1/4 building bundle + embedded assets"
"$NODE_BIN" scripts/build.js

echo "[sea] 2/4 generating SEA blob"
"$NODE_BIN" --experimental-sea-config scripts/sea-config.json

OUT="dist/msp-pipeline-dashboard"
echo "[sea] 3/4 copying node binary -> $OUT"
cp "$NODE_BIN" "$OUT"

# Remove the signature on platforms that require it (macOS). Linux is a no-op.
if command -v codesign >/dev/null 2>&1; then
  codesign --remove-signature "$OUT" 2>/dev/null || true
fi

echo "[sea] 4/4 injecting blob with postject"
# Prefer a locally-installed postject (npm i -D postject) to avoid npx network
# prompts; fall back to npx if not present.
if [ -x node_modules/.bin/postject ]; then
  POSTJECT="node_modules/.bin/postject"
else
  echo "[sea] postject not found locally; installing..."
  npm i --no-audit --no-fund --save-dev postject@1.0.0-alpha.6
  POSTJECT="node_modules/.bin/postject"
fi
"$POSTJECT" "$OUT" NODE_SEA_BLOB dist/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

chmod +x "$OUT"
echo "[sea] DONE -> $OUT"
echo "[sea] size: $(du -h "$OUT" | cut -f1)"
echo "[sea] run it:  PORT=4317 $OUT"
