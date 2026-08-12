# MSP Pipeline Dashboard

Leadership-facing health board for MSP Jenkins pipelines: **Devtest**, **Precommit
PC**, **Master** (Local LCC / GLCC / LKG) and **Patch Releases**, with automatic
version discovery and Slack alerting when a pipeline fails its last 10 builds.

![preview](docs/preview.png)

## Run it

### Option A — Portable binary (recommended for the dev VM)

Single self-contained executable. **No Node install needed on the target box**
(works even where the system `node` is ancient). Built via Node SEA.

```bash
# Build once (needs a modern node, v20+, only at build time):
bash scripts/package-sea.sh          # → dist/msp-pipeline-dashboard

# Run it (copy the file to any x86-64 Linux host and run):
PORT=4317 ./dist/msp-pipeline-dashboard
```

### Option B — Run from source (needs Node 18+)

```bash
cd pipeline-dashboard
node server/index.js
```

The server binds `0.0.0.0` by default, so from **another machine** on the network
just open `http://<vm-ip>:4317`. Restrict to localhost with `HOST=127.0.0.1`.

Port already in use? Start on another port: `PORT=4318 ./dist/msp-pipeline-dashboard`
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
