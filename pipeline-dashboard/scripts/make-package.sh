#!/usr/bin/env bash
#
# Build installable packages for the MSP Pipeline Dashboard.
#
# Produces (under dist/packages/):
#   msp-pipeline-dashboard-<ver>-linux-<arch>-portable.tar.gz
#       -> self-contained binary + installer. NO Node needed on the target.
#   msp-pipeline-dashboard-<ver>-source.tar.gz
#       -> Node source + installer. Needs Node >= 18 on the target.
#
# Each tarball unpacks to a single top-level dir and contains install.sh.
#
# Usage:
#   bash scripts/make-package.sh            # build both flavors (binary if node>=20)
#   SKIP_BINARY=1 bash scripts/make-package.sh   # source package only
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version" 2>/dev/null || echo 0.0.0)"
ARCH="$(uname -m)"
NAME="msp-pipeline-dashboard"
OUTDIR="$ROOT/dist/packages"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

log() { printf '[pkg] %s\n' "$*"; }

mkdir -p "$OUTDIR"

# Files shared by every package flavor.
copy_common() {
  local dst="$1"
  mkdir -p "$dst"
  cp packaging/install.sh                          "$dst/install.sh"
  cp packaging/uninstall.sh                        "$dst/uninstall.sh"
  cp packaging/$NAME.service                        "$dst/$NAME.service"
  cp packaging/$NAME.env                            "$dst/$NAME.env"
  cp packaging/README.txt                          "$dst/README.txt"
  [ -f PIPELINE-CONTEXT.md ] && cp PIPELINE-CONTEXT.md "$dst/PIPELINE-CONTEXT.md" || true
  [ -f README.md ]           && cp README.md           "$dst/APP-README.md"       || true
  chmod +x "$dst/install.sh" "$dst/uninstall.sh"
}

# ---------------------------------------------------------------------------
# 1. Source package (always buildable — no compiler / modern node needed)
# ---------------------------------------------------------------------------
build_source_pkg() {
  local dir="$NAME-$VERSION-source"
  local dst="$STAGE/$dir"
  log "assembling source package -> $dir"
  copy_common "$dst"
  cp -a server "$dst/server"
  cp -a public "$dst/public"
  cp -a package.json "$dst/package.json"
  ( cd "$STAGE" && tar czf "$OUTDIR/$dir.tar.gz" "$dir" )
  log "wrote dist/packages/$dir.tar.gz ($(du -h "$OUTDIR/$dir.tar.gz" | cut -f1))"
}

# ---------------------------------------------------------------------------
# 2. Portable package (bundles the SEA binary — needs node>=20 at BUILD time)
# ---------------------------------------------------------------------------
build_portable_pkg() {
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$major" -lt 20 ]; then
    log "SKIP portable: build needs node>=20 (have $(node -v 2>/dev/null || echo none)). Source package still produced."
    return 0
  fi

  log "building portable binary via scripts/package-sea.sh"
  bash scripts/package-sea.sh

  local dir="$NAME-$VERSION-linux-$ARCH-portable"
  local dst="$STAGE/$dir"
  log "assembling portable package -> $dir"
  copy_common "$dst"
  install -D -m 0755 "dist/$NAME" "$dst/bin/$NAME"
  # Include source too, so install.sh can fall back if the binary won't run.
  cp -a server "$dst/server"
  cp -a public "$dst/public"
  cp -a package.json "$dst/package.json"
  ( cd "$STAGE" && tar czf "$OUTDIR/$dir.tar.gz" "$dir" )
  log "wrote dist/packages/$dir.tar.gz ($(du -h "$OUTDIR/$dir.tar.gz" | cut -f1))"
}

build_source_pkg
if [ "${SKIP_BINARY:-0}" != "1" ]; then
  build_portable_pkg
fi

log "DONE. Packages in dist/packages/:"
ls -1sh "$OUTDIR"/*.tar.gz 2>/dev/null || true
