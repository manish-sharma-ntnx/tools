#!/usr/bin/env bash
#
# Installer for the MSP Pipeline Dashboard.
#
# Run this from inside the unpacked package directory:
#     sudo ./install.sh
#
# What it does:
#   - Installs the app to /opt/msp-pipeline-dashboard
#   - Picks a runtime:
#       * portable binary (bin/msp-pipeline-dashboard) if present + runnable, else
#       * Node source (server/index.js) using a system node >= 18
#   - Installs a config file to /etc/msp-pipeline-dashboard.env (kept on upgrade)
#   - Installs + enables a systemd service (msp-pipeline-dashboard)
#
# Env overrides:
#   INSTALL_DIR   (default /opt/msp-pipeline-dashboard)
#   CONFIG_FILE   (default /etc/msp-pipeline-dashboard.env)
#   RUN_USER      (default msp-dash; created as a system user if missing)
#   FORCE_SOURCE=1  force the Node-source runtime even if a binary exists
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
# 1. Decide runtime: portable binary vs node source
# ---------------------------------------------------------------------------
USE_BINARY=0
BIN_SRC="$SELF_DIR/bin/$SERVICE_NAME"
# Check the binary is loadable on this host WITHOUT executing it (the SEA binary
# always boots the server, so we can't use --version). Match arch + resolve libs.
binary_is_runnable() {
  local bin="$1"
  [ -x "$bin" ] || return 1
  # Architecture must match.
  local host_arch bin_arch
  host_arch="$(uname -m)"
  bin_arch="$(file -b "$bin" 2>/dev/null || true)"
  case "$host_arch" in
    x86_64|amd64) echo "$bin_arch" | grep -qi 'x86-64\|x86_64' || return 1 ;;
    aarch64|arm64) echo "$bin_arch" | grep -qi 'aarch64\|arm64' || return 1 ;;
  esac
  # All shared libs (glibc, etc.) must resolve on this host.
  if command -v ldd >/dev/null 2>&1; then
    ldd "$bin" 2>/dev/null | grep -qi 'not found' && return 1
  fi
  return 0
}
if [ "${FORCE_SOURCE:-0}" != "1" ] && [ -x "$BIN_SRC" ]; then
  if binary_is_runnable "$BIN_SRC"; then
    USE_BINARY=1
  else
    log "bundled binary present but not runnable on this host (arch/glibc mismatch); falling back to Node source"
  fi
fi

NODE_BIN=""
if [ "$USE_BINARY" -ne 1 ]; then
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || die "no portable binary usable and no 'node' found. Install Node >= 18 or use a package built for this architecture."
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 18 ] || die "found node $("$NODE_BIN" -v) but need >= 18. Upgrade node or use the portable binary package."
  log "using Node source runtime: $NODE_BIN ($("$NODE_BIN" -v))"
else
  log "using bundled portable binary (no Node required)"
fi

# ---------------------------------------------------------------------------
# 2. Create the service user
# ---------------------------------------------------------------------------
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "creating system user: $RUN_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$RUN_USER"
fi

# ---------------------------------------------------------------------------
# 3. Copy files into INSTALL_DIR
# ---------------------------------------------------------------------------
log "installing to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [ "$USE_BINARY" -eq 1 ]; then
  install -D -m 0755 "$BIN_SRC" "$INSTALL_DIR/bin/$SERVICE_NAME"
  EXEC_START="$INSTALL_DIR/bin/$SERVICE_NAME"
else
  # Copy the source tree needed to run from node.
  rm -rf "$INSTALL_DIR/server" "$INSTALL_DIR/public"
  cp -a "$SELF_DIR/server" "$INSTALL_DIR/server"
  cp -a "$SELF_DIR/public" "$INSTALL_DIR/public"
  [ -f "$SELF_DIR/package.json" ] && cp -a "$SELF_DIR/package.json" "$INSTALL_DIR/package.json"
  EXEC_START="$NODE_BIN $INSTALL_DIR/server/index.js"
fi
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
  log "Run manually with:  EnvironmentFile=$CONFIG_FILE  $EXEC_START"
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
