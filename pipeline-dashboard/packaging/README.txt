MSP Pipeline Dashboard — installable package
============================================

A leadership-facing health board for MSP Jenkins pipelines (Devtest, Master,
Patch Releases) with auto version discovery and Slack alerting. It polls the
read-only Jenkins controllers and serves a web UI.

This package installs and runs on another x86-64 Linux system.


CONTENTS
--------
  install.sh                        installer (systemd service + config)
  uninstall.sh                      uninstaller
  msp-pipeline-dashboard.service    systemd unit template
  msp-pipeline-dashboard.env        config template -> /etc/msp-pipeline-dashboard.env
  bin/msp-pipeline-dashboard        portable binary (present in the "-portable" package)
  server/, public/, package.json    Node source (present in the "-source" package)

Two package flavors may exist:
  * ...-portable.tar.gz  — bundles a self-contained binary; NO Node needed on
    the target. Works on x86-64 Linux with glibc (RHEL/CentOS 8+, Ubuntu 20.04+).
  * ...-source.tar.gz    — needs Node >= 18 installed on the target; smaller.
A combined package contains both and the installer picks the best runtime.


QUICK INSTALL (recommended)
---------------------------
  tar xzf msp-pipeline-dashboard-*.tar.gz
  cd msp-pipeline-dashboard-*/
  sudo ./install.sh

Then open:  http://<this-host-ip>:4317/

The installer:
  - installs to /opt/msp-pipeline-dashboard
  - writes config to /etc/msp-pipeline-dashboard.env  (edit + restart to change)
  - installs a systemd service "msp-pipeline-dashboard" (auto-start on boot)
  - runs as a locked-down system user "msp-dash"


CONFIGURE
---------
  sudo vi /etc/msp-pipeline-dashboard.env      # set PORT, HOST, Slack, ...
  sudo systemctl restart msp-pipeline-dashboard

Common env vars: PORT (4317), HOST (0.0.0.0 = network-reachable; 127.0.0.1 =
localhost only), POLL_INTERVAL_MS, SLACK_WEBHOOK_URL / SLACK_ALERT_BOT_TOKEN.


MANAGE
------
  systemctl status  msp-pipeline-dashboard
  journalctl -u msp-pipeline-dashboard -f       # live logs
  systemctl restart msp-pipeline-dashboard


FIREWALL (if other machines can't reach it)
-------------------------------------------
  sudo firewall-cmd --add-port=4317/tcp --permanent && sudo firewall-cmd --reload
  # or (ufw):  sudo ufw allow 4317/tcp


RUN WITHOUT INSTALLING (ad-hoc)
-------------------------------
  # portable binary:
  PORT=4317 ./bin/msp-pipeline-dashboard
  # or from source (needs node >= 18):
  PORT=4317 node server/index.js


UNINSTALL
---------
  sudo ./uninstall.sh              # keep config + state
  sudo PURGE=1 ./uninstall.sh      # remove everything incl. user


NETWORK REQUIREMENTS
--------------------
The host must be able to reach the Jenkins controllers over HTTP/HTTPS
(anonymous read). See PIPELINE-CONTEXT.md for the controller list. No secrets
are required for status reads; Slack alerting needs a webhook or bot token.
