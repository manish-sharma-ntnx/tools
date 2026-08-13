# MSP Pipeline Dashboard

Leadership-facing health board for MSP Jenkins pipelines: **Devtest**, **Precommit
PC**, **Master** (Local LCC / GLCC / LKG) and **Patch Releases**, with automatic
version discovery and Slack alerting when a pipeline fails its last 10 builds.

![preview](docs/preview.png)

## Setup

Two ways to run it: **install as a service on another Linux host** (recommended
for anything long-lived), or **run ad-hoc** from a binary/source for quick local
use. Pick one of the sections below.

### Prerequisites

- **Build machine:** Node **≥ 20** (only needed to build the portable binary).
  Check with `node -v`.
- **Target host:** x86-64 Linux with `glibc` (RHEL/CentOS 8+, Ubuntu 20.04+) and
  `systemd`. No Node required if you use the portable package.
- **Network:** the target must reach the read-only Jenkins controllers over
  HTTP/HTTPS (see `PIPELINE-CONTEXT.md` for the list). No secrets are needed for
  status reads.

---

### A. Install as a service on another Linux host (recommended)

The installer sets up a `systemd` service, a config file, and a locked-down
service user — no manual wiring needed.

**Step 1 — Build the package** (on any box with Node ≥ 20):

```bash
cd pipeline-dashboard
npm run package:dist            # → dist/packages/*.tar.gz
```

This produces two flavors:

| Package | Needs Node on target? | Use when |
|---|---|---|
| `...-linux-x86_64-portable.tar.gz` | No (bundles the runtime) | x86-64 hosts, incl. old/no Node |
| `...-source.tar.gz` | Yes (Node ≥ 18) | any arch, smaller download |

**Step 2 — Copy the tarball to the target host:**

```bash
scp dist/packages/msp-pipeline-dashboard-*-portable.tar.gz user@target-host:~
```

**Step 3 — Unpack and install** (on the target host):

```bash
tar xzf msp-pipeline-dashboard-*-portable.tar.gz
cd msp-pipeline-dashboard-*/
sudo ./install.sh               # installs to /opt, starts the systemd service
```

The installer auto-picks the runtime (bundled binary if it runs on this host,
otherwise falls back to Node source), creates the `msp-dash` service user, and
enables the service to start on boot.

**Step 4 — Configure (optional) and restart:**

```bash
sudo vi /etc/msp-pipeline-dashboard.env      # set PORT, HOST, Slack, …
sudo systemctl restart msp-pipeline-dashboard
```

**Step 5 — Open a firewall port if reaching it from another machine:**

```bash
# firewalld (RHEL/CentOS):
sudo firewall-cmd --add-port=4317/tcp --permanent && sudo firewall-cmd --reload
# ufw (Ubuntu):
sudo ufw allow 4317/tcp
```

**Step 6 — Verify:** open `http://<target-host-ip>:4317/`.

Manage the service:

```bash
systemctl status msp-pipeline-dashboard
journalctl -u msp-pipeline-dashboard -f      # live logs
sudo ./uninstall.sh                          # remove (PURGE=1 to wipe config+state)
```

See `packaging/README.txt` (included in each tarball) for full details.

---

### B. Run ad-hoc (no service)

**Option B1 — Portable binary** (no Node install needed on the target box; works
even where the system `node` is ancient):

```bash
# Build once (needs Node ≥ 20 at build time only):
bash scripts/package-sea.sh          # → dist/msp-pipeline-dashboard

# Copy the single file to any x86-64 Linux host and run:
PORT=4317 ./dist/msp-pipeline-dashboard
```

**Option B2 — From source** (needs Node ≥ 18, zero npm dependencies):

```bash
cd pipeline-dashboard
node server/index.js
# or: npm start
```

The server binds `0.0.0.0` by default, so from **another machine** on the network
just open `http://<vm-ip>:4317`. Restrict to localhost with `HOST=127.0.0.1`.

Port already in use? Start on another port: `PORT=4318 node server/index.js`
(or free it: `fuser -k 4317/tcp`).

The server polls the (read-only) Jenkins controllers every 3 minutes and serves
the dashboard.

## Configuration (all optional, via env vars)

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = localhost only) |
| `POLL_INTERVAL_MS` | `180000` | Status poll cadence |
| `SLACK_WEBHOOK_URL` | — | Incoming webhook for failure alerts (recommended) |
| `SLACK_ALERT_BOT_TOKEN` | — | Bot token alternative (`chat.postMessage`) |
| `SLACK_CHANNEL` | `#test-msp` | Alert channel |
| `SLACK_MENTION` | `@msp-help` | Group to tag |
| `SLACK_COOLDOWN_MS` | `21600000` | Per-pipeline re-alert suppression (6h) |

Example with Slack enabled:

```bash
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ" node server/index.js
```

## Features

- **Auto version discovery** — new `ganges-<version>` patch pipelines show up
  automatically. Click **Fetch latest releases** to force an immediate re-scan.
- **Last-10 build sparkline** per pipeline with hover details, success rate, and a
  consecutive-failure warning.
- **Master section** grouped as `msp-master` (Precommit + Local LCC + GLCC) with a
  standalone LKG master.
- **Patch-release comparison** — pick any two versions from dropdowns and compare
  their lanes side by side.
- **Slack alert** to `#test-msp` tagging `@msp-help` when all last 10 builds fail.
- **Nutanix-themed** dark UI with live/stale indicator and controller reachability.

See `PIPELINE-CONTEXT.md` for architecture, Jenkins API details, and design
decisions.

## API

- `GET /api/pipelines` — full snapshot JSON
- `POST /api/refresh` — force re-discovery + poll
- `GET /api/health` — liveness
