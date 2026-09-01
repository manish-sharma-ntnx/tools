#!/usr/bin/env bash
#
# Build installable tarball(s) for the MSP Pipeline Dashboard (Go).
#
# Produces, for each target platform, a self-contained package:
#   dist/packages/msp-pipeline-dashboard-<version>-linux-<arch>.tar.gz
# containing the single binary + systemd installer.
#
# Usage:
#   ./packaging/make-package.sh                 # build for linux/amd64 + linux/arm64
#   TARGETS="linux/amd64" ./packaging/make-package.sh
#
set -euo pipefail

GO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$GO_DIR"

SERVICE_NAME="msp-pipeline-dashboard"
VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
TARGETS="${TARGETS:-linux/amd64 linux/arm64}"
OUT="dist/packages"
LDFLAGS="-s -w -X main.version=$VERSION"

log() { printf '[package] %s\n' "$*"; }

# Refresh the embedded UI from the canonical public/ dir before building.
log "syncing web assets from ../public"
cp ../public/index.html ../public/styles.css ../public/app.js ../public/favicon.svg webui/web/

mkdir -p "$OUT"

for target in $TARGETS; do
  goos="${target%/*}"
  goarch="${target#*/}"
  log "building $goos/$goarch (version $VERSION)"

  stage="$(mktemp -d)"
  pkgdir="$stage/${SERVICE_NAME}-${VERSION}-${goos}-${goarch}"
  mkdir -p "$pkgdir/bin"

  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -ldflags "$LDFLAGS" -o "$pkgdir/bin/$SERVICE_NAME" ./cmd/dashboard

  cp packaging/install.sh                    "$pkgdir/install.sh"
  cp packaging/uninstall.sh                  "$pkgdir/uninstall.sh"
  cp packaging/$SERVICE_NAME.service         "$pkgdir/$SERVICE_NAME.service"
  cp packaging/$SERVICE_NAME.env             "$pkgdir/$SERVICE_NAME.env"
  cp packaging/README.txt                    "$pkgdir/README.txt"
  chmod +x "$pkgdir/install.sh" "$pkgdir/uninstall.sh"

  tarball="$OUT/${SERVICE_NAME}-${VERSION}-${goos}-${goarch}.tar.gz"
  tar -C "$stage" -czf "$tarball" "$(basename "$pkgdir")"
  rm -rf "$stage"
  log "wrote $tarball"
done

log "DONE. Packages in $OUT/"
ls -la "$OUT/"
