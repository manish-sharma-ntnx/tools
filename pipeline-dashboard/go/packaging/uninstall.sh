#!/usr/bin/env bash
#
# Uninstaller for the MSP Pipeline Dashboard (Go build).
#     sudo ./uninstall.sh            # remove app + service, keep config & state
#     sudo PURGE=1 ./uninstall.sh    # also remove config, state dir, and user
#
set -euo pipefail

SERVICE_NAME="msp-pipeline-dashboard"
INSTALL_DIR="${INSTALL_DIR:-/opt/msp-pipeline-dashboard}"
CONFIG_FILE="${CONFIG_FILE:-/etc/msp-pipeline-dashboard.env}"
RUN_USER="${RUN_USER:-msp-dash}"
UNIT_PATH="/etc/systemd/system/$SERVICE_NAME.service"

log() { printf '[uninstall] %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || { echo "[uninstall] ERROR: run as root" >&2; exit 1; }

if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT_PATH" ]; then
  log "stopping + disabling service"
  systemctl stop "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
fi

log "removing $INSTALL_DIR"
rm -rf "$INSTALL_DIR"

if [ "${PURGE:-0}" = "1" ]; then
  log "PURGE=1: removing config, state, and user"
  rm -f "$CONFIG_FILE"
  rm -rf "/var/lib/$SERVICE_NAME"
  userdel "$RUN_USER" 2>/dev/null || true
else
  log "kept config ($CONFIG_FILE) and state (/var/lib/$SERVICE_NAME). Use PURGE=1 to remove."
fi

log "DONE."
