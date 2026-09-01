# MSP Pipeline Dashboard — Go

Go port of the MSP Pipeline Dashboard. Same behavior and same `/api/*` contract
as the original Node implementation, compiled to a **single self-contained
binary** with the web UI embedded via `go:embed` (no sibling `public/` needed).

This directory is the in-progress migration target. The canonical UI still lives
in `../public/`; `make sync-web` copies it into `webui/web/` before building.

## Why Go

- `net/http` + `crypto/tls` replace Node's `http`/`https` with per-host TLS
  policy (`InsecureSkipVerify` for the internal-CA corp controllers).
- Goroutines + a semaphore give the bounded-concurrency Jenkins fan-out.
- `time.LoadLocation` drives the DST-aware digest scheduler (no cron).
- `//go:embed` yields the portable single binary — this replaces the Node SEA
  build entirely (no postject, no runtime copy).
- Zero third-party dependencies (stdlib only), like the Node original.

## Layout

```
go/
  cmd/dashboard/main.go       # entrypoint: listener, poll loop, scheduler wiring
  internal/
    config/                   # controllers, discovery rules, settings, slack/digest cfg
    jenkins/                  # TLS-aware JSON client, folder listing, job fetch, MapLimit
    discovery/                # version-regex discovery, semver compare/sort, train grouping
    store/                    # poll loop, normalize, last-10 math, snapshot (RWMutex)
    model/                    # Card, Snapshot, VersionBlock, Build, Alert (JSON-compatible)
    slack/                    # webhook + bot chat.postMessage, cooldown, master digest
    scheduler/                # timezone-aware daily digest
    httpapi/                  # /api/* handlers + embedded static serving
  webui/                      # go:embed of webui/web (the UI assets)
  Makefile
```

## Run

```bash
# From source (needs Go >= 1.23):
make run
# or:
go build -o msp-pipeline-dashboard ./cmd/dashboard && ./msp-pipeline-dashboard

# Custom port / bind / Slack:
PORT=4317 HOST=0.0.0.0 SLACK_BOT_TOKEN=xoxb-... ./msp-pipeline-dashboard
```

Binds `0.0.0.0:4317` by default; open `http://<vm-ip>:4317/` from any host on
the network. Set `HOST=127.0.0.1` to restrict to localhost.

## Portable binaries

```bash
make dist    # → dist/msp-pipeline-dashboard-linux-amd64, -linux-arm64, -darwin-arm64
make clean   # removes the local binary and dist/
```

`dist/` is generated and gitignored. Rebuild anytime with `make dist` or `make package`.

Each is fully self-contained (runtime + app + UI). Copy one file to the target
host and run it — no Go, no Node, no `public/` directory required.

## Config (env vars)

Identical to the Node version. Key ones:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `POLL_INTERVAL_MS` | `180000` | Status poll cadence |
| `DATA_DIR` | `./data` | Alert cooldown state dir |
| `SLACK_ENABLED` | `true` | `false` pauses all Slack posts; dashboard keeps running |
| `SLACK_BOT_TOKEN` | — | Bot token (`xoxb-…`) for the master digest |
| `SLACK_WEBHOOK_URL` | — | Incoming webhook for failure alerts |
| `SLACK_CHANNEL` | `#test-msp` | Alert/digest channel |
| `MASTER_FAIL_THRESHOLD` | `5` | Consecutive failures to report a master pipeline |
| `MASTER_DIGEST_TIMES` | `09:00 Asia/Kolkata,09:00 America/Los_Angeles` | Daily post times |
| `DASHBOARD_URL` | auto | Public URL for the Slack "Open dashboard" link |

## API

- `GET  /api/pipelines` — full snapshot JSON (shape-identical to Node)
- `GET  /api/alerts` — per-pipeline alert history + frequency (count, perDay, avgGapHours, last7Days, last30Days)
- `POST /api/refresh` — force re-discovery + poll
- `GET  /api/health` — liveness
- `GET  /api/digest/preview` — master pipelines currently ≥ threshold (no post)
- `POST /api/digest/test` — force a master-digest Slack post now

## Parity

Verified against the Node server on live Jenkins data: identical `stats`,
version blocks, block labels, and every card's `status` / `successRate` /
`consecutiveFailures` / `allFailing` / `completedCount`. JSON field shapes match
(optional strings and in-flight `result` serialize as `null`, `lastTimestamp`
always present), so the existing web UI runs unchanged.
