#!/usr/bin/env bash
#
# Installer for the MSP Pipeline Dashboard (Go build).
#
# Run this from inside the unpacked package directory:
#     sudo ./install.sh
#
# What it does:
#   - Verifies the bundled single binary runs on this host (arch + glibc)
#   - Installs the app to /opt/msp-pipeline-dashboard
#   - Installs a config file to /etc/msp-pipeline-dashboard.env (kept on upgrade)
#   - Creates a locked-down system user and enables a systemd service
#
# The Go binary is fully self-contained (runtime + app + web UI embedded), so
# there is NO Node/interpreter dependency and no source fallback.
#
# Env overrides:
#   INSTALL_DIR   (default /opt/msp-pipeline-dashboard)
#   CONFIG_FILE   (default /etc/msp-pipeline-dashboard.env)
#   RUN_USER      (default msp-dash; created as a system user if missing)
#   NO_SERVICE=1    install files only, skip systemd
#
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="msp-pipeline-dashboard"
INSTALL_DIR="${INSTALL_DIR:-/opt/msp-pipeline-dashboard}"
CONFIG_FILE="${CONFIG_FILE:-/etc/msp-pipeline-dashboard.env}"
RUN_USER="${RUN_USER:-msp-dash}"
RUN_GROUP="$RUN_USER"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "please run as root (sudo ./install.sh)"

# ---------------------------------------------------------------------------
# 1. Locate and verify the bundled binary
# ---------------------------------------------------------------------------
BIN_SRC="$SELF_DIR/bin/$SERVICE_NAME"
[ -x "$BIN_SRC" ] || die "bundled binary not found or not executable: $BIN_SRC"

# Architecture must match the host.
host_arch="$(uname -m)"
bin_desc="$(file -b "$BIN_SRC" 2>/dev/null || true)"
case "$host_arch" in
  x86_64|amd64)
    echo "$bin_desc" | grep -qi 'x86-64\|x86_64' \
      || die "binary arch mismatch: host is $host_arch but binary is: $bin_desc. Rebuild with 'make dist' for this arch." ;;
  aarch64|arm64)
    echo "$bin_desc" | grep -qi 'aarch64\|arm64' \
      || die "binary arch mismatch: host is $host_arch but binary is: $bin_desc. Rebuild with 'make dist' for this arch." ;;
  *)
    log "unknown host arch '$host_arch'; skipping strict arch check" ;;
esac

# Go binaries are typically static, but CGO builds may link glibc. If dynamic,
# confirm all libs resolve.
if command -v ldd >/dev/null 2>&1; then
  if ldd "$BIN_SRC" 2>/dev/null | grep -qi 'not found'; then
    die "binary has unresolved shared libraries on this host (glibc mismatch). Rebuild for this platform."
  fi
fi
log "bundled binary verified for $host_arch (self-contained, no Node needed)"

# ---------------------------------------------------------------------------
# 2. Create the service user
# ---------------------------------------------------------------------------
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "creating system user: $RUN_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$RUN_USER"
fi

# ---------------------------------------------------------------------------
# 3. Install the binary
# ---------------------------------------------------------------------------
log "installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
install -D -m 0755 "$BIN_SRC" "$INSTALL_DIR/bin/$SERVICE_NAME"
EXEC_START="$INSTALL_DIR/bin/$SERVICE_NAME"
chown -R "$RUN_USER":"$RUN_GROUP" "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# 4. Config file (do not clobber an existing one on upgrade)
# ---------------------------------------------------------------------------
if [ -f "$CONFIG_FILE" ]; then
  log "keeping existing config: $CONFIG_FILE"
else
  log "installing config: $CONFIG_FILE"
  install -m 0644 "$SELF_DIR/$SERVICE_NAME.env" "$CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# 5. systemd service
# ---------------------------------------------------------------------------
if [ "${NO_SERVICE:-0}" = "1" ]; then
  log "NO_SERVICE=1 set; skipping systemd setup."
  log "Run manually with:  set -a; . $CONFIG_FILE; set +a; DATA_DIR=/var/lib/$SERVICE_NAME $EXEC_START"
  exit 0
fi

if ! command -v systemctl >/dev/null 2>&1; then
  log "systemd not found; skipping service install."
  log "Start manually:  set -a; . $CONFIG_FILE; set +a; DATA_DIR=/var/lib/$SERVICE_NAME $EXEC_START"
  exit 0
fi

UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"
log "writing $UNIT_PATH"
sed \
  -e "s|__EXEC_START__|$EXEC_START|g" \
  -e "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" \
  -e "s|__RUN_USER__|$RUN_USER|g" \
  -e "s|__RUN_GROUP__|$RUN_GROUP|g" \
  "$SELF_DIR/$SERVICE_NAME.service" > "$UNIT_PATH"

mkdir -p /var/lib/$SERVICE_NAME
chown "$RUN_USER":"$RUN_GROUP" /var/lib/$SERVICE_NAME

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

sleep 1
PORT_VAL="$(. "$CONFIG_FILE" 2>/dev/null; echo "${PORT:-4317}")"
log "service status:"
systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
cat <<EOF

[install] DONE.
  Service : $SERVICE_NAME  (systemctl status $SERVICE_NAME)
  Config  : $CONFIG_FILE   (edit, then: systemctl restart $SERVICE_NAME)
  Logs    : journalctl -u $SERVICE_NAME -f
  URL     : http://<this-host-ip>:${PORT_VAL}/

To uninstall:  sudo ./uninstall.sh
EOF
