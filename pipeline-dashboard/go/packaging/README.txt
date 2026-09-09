MSP Pipeline Dashboard (Go) — install package
==============================================

This tarball contains a single self-contained Go binary (HTTP server + Jenkins
poller + Slack digest + the web UI embedded) plus a systemd installer. There is
NO Node, interpreter, or sibling public/ directory required.

Contents
--------
  bin/msp-pipeline-dashboard        the self-contained server binary
  msp-pipeline-dashboard.service    systemd unit template
  msp-pipeline-dashboard.env        config file (copied to /etc on install)
  install.sh                        installer (systemd + service user)
  uninstall.sh                      uninstaller
  README.txt                        this file

Quick install (on the target Linux host)
-----------------------------------------
  tar xzf msp-pipeline-dashboard-*-linux-<arch>.tar.gz
  cd msp-pipeline-dashboard-*/
  sudo ./install.sh

The installer:
  - verifies the binary matches this host's architecture (and resolves libs),
  - installs it to /opt/msp-pipeline-dashboard,
  - creates the locked-down 'msp-dash' system user,
  - installs /etc/msp-pipeline-dashboard.env (kept as-is on upgrades),
  - enables + starts the 'msp-pipeline-dashboard' systemd service.

Configure
---------
  sudo vi /etc/msp-pipeline-dashboard.env      # port, bind, Slack token, digest
  sudo systemctl restart msp-pipeline-dashboard

Minimum for Slack posting:
  SLACK_ENABLED=true
  SLACK_BOT_TOKEN=xoxb-...        # app needs chat:write; invite bot to channel
  SLACK_CHANNEL=#test-msp
  DASHBOARD_URL=http://<this-host-fqdn-or-ip>:4317
  MASTER_FAIL_THRESHOLD=5         # master digest bar (default 5)
  PATCH_FAIL_THRESHOLD=3          # patch-lane per-poll alert bar (default 3)
  SUCCESS_DIGEST_ENABLED=false    # green success digest (off by default)
  SUCCESS_THRESHOLD=5             # consecutive successes for that digest
  MASTER_DIGEST_TIMES=09:00       # 24-hour clock (21:00 = 9pm)
  MASTER_DIGEST_TZ=IST,PST        # IST=India, PST=US-Pacific

Start / pause Slack (dashboard stays up):
  # Pause every Slack post (10-fail alerts + daily digest):
  sudo sed -i 's/^SLACK_ENABLED=.*/SLACK_ENABLED=false/' /etc/msp-pipeline-dashboard.env
  sudo systemctl restart msp-pipeline-dashboard

  # Resume posting (tokens stay in the env file):
  sudo sed -i 's/^SLACK_ENABLED=.*/SLACK_ENABLED=true/' /etc/msp-pipeline-dashboard.env
  sudo systemctl restart msp-pipeline-dashboard

  # Pause only the daily master digest (10-fail alerts still post):
  #   MASTER_DIGEST_ENABLED=false   then restart

  # Preview / force a digest (does nothing if SLACK_ENABLED=false):
  curl -s http://<host>:4317/api/digest/preview
  curl -s -X POST http://<host>:4317/api/digest/test

Open a firewall port (if reaching from another machine)
-------------------------------------------------------
  # firewalld (RHEL/CentOS):
  sudo firewall-cmd --add-port=4317/tcp --permanent && sudo firewall-cmd --reload
  # ufw (Ubuntu):
  sudo ufw allow 4317/tcp

Verify
------
  curl -s http://<host>:4317/api/health
  curl -s http://<host>:4317/api/digest/preview       # who meets threshold
  curl -s -X POST http://<host>:4317/api/digest/test   # force a test Slack post
  open  http://<host>:4317/

Manage
------
  systemctl status msp-pipeline-dashboard
  journalctl -u msp-pipeline-dashboard -f
  sudo ./uninstall.sh                # remove (PURGE=1 to also wipe config+state)

Install without systemd
-----------------------
  sudo NO_SERVICE=1 ./install.sh     # files only; run the binary yourself

Notes
-----
  - The binary is arch/OS specific. Use the tarball matching the target
    (linux-amd64 or linux-arm64). Rebuild with 'make dist' for others.
  - All Jenkins access is read-only/anonymous; no secrets are needed for status.
  - Runtime state (alert cooldowns) lives in /var/lib/msp-pipeline-dashboard.
