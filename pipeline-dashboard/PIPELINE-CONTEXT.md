# MSP Pipeline Dashboard — Context & Design Decisions

A leadership-facing dashboard that tracks MSP Jenkins pipeline health across
**Devtest**, **Master**, and **Patch Release** pipelines, with automatic version
discovery and Slack alerting when a pipeline fails its last 10 builds.

This document is the single source of truth for *why* the system is built the way
it is, how the Jenkins data is consumed, and a per-run token ledger.

---

## 1. What it tracks

> **Codebase location:** `/home/manish.sharma/Nutanix/github/tools/pipeline-dashboard`.

| Category | Lane | Controller | Jenkins path |
|---|---|---|---|
| Devtest | precommit | `10.37.10.188:8080` | `msp-controller-precommit` |
| Master (msp-master) | Precommit | SB Prod Controller-3 | `Nupipe/Precommit_NOS/msp-master` |
| Master (msp-master) | Local LCC | SB Prod Controller-2 | `Nupipe/LCC_NOS/msp-master` |
| Master (msp-master) | GLCC | SB Prod Controller-2 | `Nupipe/LCC_Dial_Tests/msp-master` |
| Master (msp-master) | Smoke | SB Prod Controller-1 | `Postcommit/master` |
| Master (standalone) | LKG | Harbinger Prod-14 | `Nupipe/LKG/master` |
| Patch release | Precommit | Harbinger Prod-12 | `Nupipe/Precommit_PC/msp-ganges-<ver>-pc` |
| Patch release | Local LCC | SB Prod Controller-2 | `Nupipe/LCC_NOS/msp-ganges-<ver>` |
| Patch release | GLCC | SB Prod Controller-2 | `Nupipe/LCC_Dial_Tests/msp-ganges-<ver>` |
| Patch release | Smoke | SB Prod Controller-1 | `Postcommit/ganges-<ver>-stable` |
| Patch release | LKG (current) | SB Prod Controller-1 | `Nupipe/LKG/ganges-<ver>-stable` |
| Patch release | LKG (older 7.5.x) | Harbinger Prod-14 | `Nupipe/LKG/ganges-<ver>-stable` |

> **Master section semantics:** Precommit + Local LCC + GLCC are stages of the
> `msp-master` pipeline and are grouped together; **LKG** is a separate mainline
> shown standalone.
>
> **Precommit master** is the real `msp-master` job on **SB Prod Controller-3**
> under `Nupipe/Precommit_NOS/msp-master` (discovery rule `precommit-master`).
> Earlier iterations synthesized this card from the newest `Precommit_PC` version
> on Harbinger-12; that was corrected to point at the true master job.
>
> **Precommit patch versions** still come from **Harbinger Prod-12**
> `Nupipe/Precommit_PC/msp-ganges-<ver>-pc` (rule `precommit-pc`) and feed the
> patch-release comparison only (they no longer contribute a master card).
>
> The Devtest `msp-controller-precommit` job remains the Devtest card.
>
> **LKG controller split (2026-09-01):** master LKG remains Harbinger-14
> `Nupipe/LKG/master`. Versioned LKG for current trains (7.6.x, **7.7**, …)
> lives on **SB Prod Controller-1** `Nupipe/LKG/ganges-<ver>-stable`. Fetch
> latest did not show 7.7 before because discovery only listed Harbinger-14,
> which has no `ganges-7.7-stable` job. The `-stable-pc` sibling is still
> excluded (same as other `-pc` LKG jobs).
>
> **Smoke** is `Postcommit` on SB Prod Controller-1 (`master` +
> `ganges-<ver>-stable`).

---

## 2. How Jenkins status is fetched (the core question)

Jenkins exposes a **JSON API** on every job and folder: append `/api/json` to any
job URL. It supports a `tree=` query param to select exactly the fields we need,
which keeps responses tiny and fast.

**All Jenkins controllers allow anonymous (read-only) access** — verified live for
Devtest, SB Prod Controller-1 (Postcommit + LKG), SB Prod Controller-2,
Harbinger-12, Harbinger-14, and **SB Prod Controller-3** (`Precommit_NOS/msp-master`,
re-verified 2026-08-31). No tokens are required to read status. TLS on the corp `*.ntnxdpro.com` /
`*.eng.nutanix.com` controllers uses an internal CA, so the HTTP client is
configured to not reject those certs (`rejectUnauthorized:false`) per-host.

Per-job call we make:

```
GET <job>/api/json?tree=name,color,url,
    builds[number,result,building,timestamp,duration,url]{0,10},
    lastBuild[number,result,building,timestamp],
    healthReport[score,description]
```

- `color` — encodes both status and "building" (e.g. `blue`, `red`, `blue_anime`
  where `_anime` = currently running).
- `builds[...]{0,10}` — the **last 10 builds** with result + timing. This is the
  backbone of the sparkline and the 10-consecutive-failure alert rule.
- `result` values: `SUCCESS`, `FAILURE`, `UNSTABLE`, `ABORTED`, or `null` while
  building.

We normalize these into our own vocabulary: `success | failed | running |
unstable | aborted | unreachable | unknown` (see `normalizeStatus` in
`server/store.js`).

### Consecutive-failure math
`consecutiveFailures` counts failures from the newest completed build backwards,
skipping any in-flight build at the head. `allFailing` is true when the last 10
**completed** builds contain zero successes — that is the alert trigger.

---

## 3. Version discovery & auto-fetch of new releases

**The insight:** patch-release job names encode the version, and they live as
siblings of the `master` job inside a known folder. So discovery = *list the
folder's child jobs and regex the version out of each name.*

Observed naming (live):

- SB Prod (`LCC_NOS`, `LCC_Dial_Tests`): `msp-master`, `msp-ganges-7.6`
  → regex `^msp-ganges-(\d+(?:\.\d+)*)$`
- Harbinger-14 (`LKG`): `master`, `ganges-7.6-stable`, `ganges-7.5.1.10-stable`,
  `ganges-7.6.9.3-stable` → regex `^ganges-(\d+(?:\.\d+)*)-stable$`
- Harbinger-12 (`Precommit_PC`): `msp-ganges-7.6-pc`, `msp-ganges-7.6.9.3-pc`
  → regex `^msp-ganges-(\d+(?:\.\d+)*)-pc$` (deliberately excludes
  `msp-feat-9.8-test-pc` and `msp-ncm-*-release` in the same folder)

Versions therefore range from 2-part (`7.6`) to 4-part (`7.6.9.3`,
`7.5.1.10`) and are compared numerically segment-by-segment
(`compareVersions`), newest first.

**"Fetch latest releases" button** → `POST /api/refresh` → forces a fresh folder
listing (`forceDiscovery:true`) so brand-new `ganges-<newver>` jobs appear without
a code change or restart. Discovery is also auto-refreshed every 30 min and on a
regular poll cadence (default 3 min) for status.

### Clubbing under version blocks
The UI groups pipelines into **blocks**:
- One **Master** block clubs the three master lanes (Local LCC, GLCC, LKG).
- One block **per discovered version**, clubbing every lane that has that version.
  Blocks are labeled with the version and its train (major.minor, e.g. `7.6`),
  sorted newest-first. Older patch blocks start collapsed to keep the leadership
  view focused.

---

## 4. Slack alerting (10-in-a-row failures)

Rule: **if a pipeline's last 10 completed builds are all non-success**, post to
`#test-msp` tagging `@msp-help` with the pipeline, version, lane, latest build
number, a Jenkins deep link, and an **Open MSP Pipeline Dashboard** link
(same Block Kit shape as the master digest).

A second, scheduled **master digest** posts at 09:00 IST and 09:00 US-Pacific
when any master lane (msp-master Precommit / Local LCC / GLCC, plus standalone
LKG) has ≥ `MASTER_FAIL_THRESHOLD` (default 5) consecutive failures. The scheduled
run still posts nothing when the board is clean. `POST /api/digest/test` always
attempts a Slack post: the failure digest if anything qualifies, otherwise an
all-clear so the channel/token can be verified. The response includes `posted`,
`count`, `reason`, `channel`, `slackEnabled`, and `hasBotToken`.

Transport (in priority order, all env-configurable):
1. `SLACK_WEBHOOK_URL` — incoming webhook (10-fail alerts only).
2. `SLACK_BOT_TOKEN` / `SLACK_ALERT_BOT_TOKEN` — bot token → `chat.postMessage`
   (alerts + digest). Required for the digest.
3. Neither set → the alert is **logged** (never silently dropped).

A **cooldown** (`SLACK_COOLDOWN_MS`, default 6h) per-pipeline prevents re-spamming
the channel every poll while a pipeline stays red. State persists in
`data/alert-state.json`.

### Start / pause the channel (operator)

`SLACK_ENABLED` is the master switch. Default `true`. Set `false` to pause
**every** Slack post without removing tokens; the dashboard keeps polling.

| Goal | Config (then `systemctl restart msp-pipeline-dashboard`) |
|---|---|
| Start posting | `SLACK_ENABLED=true` + `SLACK_BOT_TOKEN=xoxb-…` |
| Pause all Slack (keep dashboard) | `SLACK_ENABLED=false` |
| Pause only the daily digest | `MASTER_DIGEST_ENABLED=false` |
| Stop the whole service | `systemctl stop msp-pipeline-dashboard` |

While `SLACK_ENABLED=false`, events are logged
(`[slack] (SLACK_ENABLED=false)…`) and **cooldown is not consumed**, so the
next poll after resume can post immediately if a pipeline is still fully
failing. Full install + Slack steps live in `README.md` §A / §B.

> Note on tokens found in the environment (2026-08-12): `SLACK_BOT_TOKEN`
> failed `auth.test` (`invalid_auth`) and `SLACK_APP_TOKEN` is an app-level
> token (`xapp-…`, app "ASK MSP") which cannot post messages. A valid webhook
> or bot token must be supplied via env for live posting. The rule engine and
> message formatting were exercised live (LKG 7.6.9.3 triggered the alert path).

---

## 4b. Go rewrite + code-tracker UI (2026-08-26)

The dashboard was migrated from **Node.js to Go** and the frontend was
restyled to a light theme and then **reorganized into three tabs**
(*MSP Pipeline Status* title): **Pipeline Status**, **Analytics**, **Alerts**
(see §4c). Both changes are additive during the transition: the Node backend
still exists under `server/`, and the Go port lives under `go/`.

### Why Go
- `net/http` + `crypto/tls` replace Node's `http`/`https`; the per-host TLS
  policy (`InsecureSkipVerify` for the internal-CA corp controllers) replaces
  `rejectUnauthorized:false`.
- Goroutines + a semaphore give the bounded-concurrency Jenkins fan-out.
- `time.LoadLocation` drives the DST-aware digest scheduler (no cron, no deps).
- `//go:embed` yields a **single self-contained, statically-linked binary** with
  the web UI baked in. This **replaces the Node SEA build entirely** (no
  postject, no `node` copy, no glibc dependency). Verified: `file` reports
  `statically linked`, `ldd` reports `not a dynamic executable`.
- Zero third-party dependencies (stdlib only), like the Node original.

### Parity (verified live)
Ran the Go and Node servers side-by-side against the live controllers and diffed
`/api/pipelines`: identical `stats`, version blocks, block labels, and every
card's `status` / `successRate` / `consecutiveFailures` / `allFailing` /
`completedCount`. JSON field shapes were made byte-compatible (optional strings
and in-flight build `result` serialize as `null`; `lastTimestamp` always
present; digest `times` use `hour`/`minute`/`tz`), so **the same `public/` UI
runs unchanged on either backend**. All 9 endpoint smoke tests pass on the Go
server (`/api/health`, `/api/pipelines`, `/api/alerts`, `/api/refresh`,
`/api/digest/*`, static assets, 404).

### UI mapping (timeline → our Jenkins data)
- Master group + each `ganges-<version>` → a **component row** in the timeline.
- Lanes map to stage columns (real Jenkins data only): `Precommit → Precommit pipeline`,
  `LCC → Local LCC`, `GLCC → Global LCC`, `Smoke → Smoke`, `LKG → LKG`.
- KPI strip: **Last Successful LKG**, master-lane sub-rows, pipeline volume,
  health, and the red **N Pipelines Failing** panel are all real.
- The earlier commit-flow **TODO placeholders** were **removed** (Awaiting-*,
  LKG-Builds/Tests columns; Pipeline ETA / commit-count / DIAL-CR KPIs; and the
  CFDs / Cherry-Picks tabs and V4/Post-LKG sub-tabs). If a Gerrit/JIRA/git
  source is wired later, reintroduce as needed.

### Installer for a new system
`go/packaging/` ships a systemd installer for the single Go binary:
`install.sh` (verifies arch + libs, installs to `/opt`, creates the `msp-dash`
system user, writes `/etc/msp-pipeline-dashboard.env`, enables the service),
`uninstall.sh`, the `.service` unit template, the `.env` config, and
`make-package.sh` which builds `dist/packages/*-linux-<arch>.tar.gz`. Because
the binary is static, the target host needs **no Node and no runtime** — just
`tar xzf … && sudo ./install.sh`. Build with `make -C go package` (or `dist`).

---

## 4c. Code Tracker tabs (2026-09-01)

The live UI keeps the **Code Tracker** chrome. Timeline columns are the real
Jenkins lanes: **Precommit pipeline**, **Local LCC**, **Global LCC**, **Smoke**,
**LKG**. Top-level tabs:

1. **Branches** — KPI strip + Component Pipeline Timeline (Jenkins data).
   The first KPI ("Last Successful LKG") links to **master LKG**
   (`Nupipe/LKG/master`), not the newest successful patch LKG.
2. **CFDs**, **Analytics**, **Cherry-Picks** — empty placeholders for now.

`GET /api/alerts` (alert history + frequency) remains on the backend.

### Alert-history persistence (both backends)
`data/alert-state.json` gained a `history` map keyed by pipeline alert key:
`{ key, title, lane, version, url, count, firstAt, lastAt, timestamps[] }`
(timestamps capped at 200/pipeline). History is recorded the moment an alert
**fires and passes cooldown** — *regardless of whether a Slack transport is
configured* — so the Alerts tab is meaningful even in log-only mode.
- Go: `internal/slack/slack.go` (`recordHistory`, `GetAlertHistory`,
  `AlertHistory`) + `internal/httpapi/handleAlerts` (computes frequency).
- Node: `server/slack.js` (`recordHistory`, `getAlertHistory`) +
  `server/index.js` `/api/alerts` handler (same frequency math).

`GET /api/alerts` returns `{ generatedAt, pipelineCount, totalAlerts,
cooldownMs, failThreshold, pipelines[] }` where each pipeline carries `count`,
`perDay`, `avgGapHours`, `last7Days`, `last30Days`, plus first/last timestamps.

---

## 5. Architecture & tech choices

> The original stack below describes the **Node** implementation. The **Go** port
> mirrors it package-for-package (`go/internal/{config,jenkins,discovery,store,
> slack,scheduler,httpapi}`, UI embedded via `go/webui`). See §4b.

- **Node.js (built-ins only), zero npm dependencies.** Node v24 ships `fetch`,
  `http/https`, and `fs`, so the whole thing runs with just `node server/index.js`
  — no install step, no supply-chain surface, trivial to deploy on a jump host.
- **Server-side polling + in-memory snapshot.** The browser hits a single fast
  `/api/pipelines` endpoint; all Jenkins fan-out (bounded concurrency of 8) happens
  server-side. This shields the read-only controllers from N-browser load and gives
  one consistent snapshot.
- **Vanilla frontend (no framework/build).** One `index.html` + `styles.css` +
  `app.js`. Loads instantly, easy to host anywhere, nothing to compile.
- **Nutanix-themed UI:** dark navy canvas, signature violet (`#7c5cff`) + cyan
  (`#3bc9db`) accents, the angular Nutanix-style chevron mark, KPI header, version
  blocks, per-build sparkline with hover tooltips, lane color-coding
  (LCC=violet, GLCC=cyan, LKG=blue), live/stale indicator, and a red alert banner
  when any pipeline is fully failing.

### File map
```
pipeline-dashboard/
  server/                    # Node backend (original; still runnable)
    config.js      # controllers, discovery rules, Slack + settings
    jenkins.js     # HTTP JSON client (TLS-aware), folder listing, job fetch
    discovery.js   # version regex discovery + semantic version sort
    store.js       # poll loop, normalization, last-10 + alert logic, snapshot
    slack.js       # webhook/bot alerting with cooldown + persisted state
    scheduler.js   # timezone-aware master-digest scheduler
    index.js       # zero-dep HTTP server: API + static hosting
  public/                    # shared web UI (code-tracker light theme)
    index.html styles.css app.js favicon.svg
  go/                        # Go port (single self-contained binary)
    cmd/dashboard/main.go
    internal/{config,jenkins,discovery,store,model,slack,scheduler,httpapi}/
    webui/web/               # UI assets embedded via go:embed (synced from public/)
    packaging/               # systemd installer for the Go binary
      install.sh uninstall.sh *.service *.env make-package.sh README.txt
    Makefile README.md
  # generated (gitignored, not source): dist/, go/dist/, data/, node_modules/
  PIPELINE-CONTEXT.md  PIPELINE-DESIGN.md  README.md
```

### API
- `GET /api/pipelines` — full snapshot (stats, static cards, version blocks).
- `POST /api/refresh` — force re-discovery + poll ("Fetch latest releases").
- `GET /api/health` — liveness.

---

## 6. Design decisions & trade-offs

1. **Anonymous read over stored creds.** All controllers permit anonymous status
   reads, so we ship with no secrets. Keeps the read-only requirement literal.
2. **Discovery by folder-listing, not hardcoding versions.** New patch trains
   appear automatically. Adding a new controller/lane is a config entry, not code.
3. **Group by exact version, visually nested under train.** The request said "club
   master and patch release under version block"; LKG carries many `7.5.x` point
   releases, so exact-version blocks are correct, and the `train` tag + collapse
   keeps the board readable for execs.
4. **Alert on completed builds only.** An in-progress build at the head shouldn't
   mask or trip the 10-fail rule; we skip `running` when evaluating the streak.
5. **Graceful degradation everywhere.** Unreachable controller → `unreachable`
   card (not a crash). No Slack transport → logged alert. Stale snapshot → header
   flips to "Stale".
6. **No build step / no deps.** Optimizes for "clone and run on a jump box" in a
   corp network where npm installs and browser downloads are unreliable.

---

## 7. Verification performed (live)

- All controllers return HTTP 200 on `/api/json` anonymously, including
  **SB Prod Controller-3** `Nupipe/Precommit_NOS/msp-master` (re-verified
  2026-08-31: folder 21 jobs, last build #253 FAILURE, #252 SUCCESS).
- Discovery found **19 pipelines across 14 version blocks** live.
- `/api/pipelines` payload validated: no undefined/null leaks in any card;
  sparkline history, success rates, lanes all populate.
- `POST /api/refresh` re-discovers and returns fresh `generatedAt`.
- Alert path fired correctly for `LKG 7.6.9.3` (10 consecutive FAILUREs) and,
  with no transport configured, logged the exact message it would post.
- All JS passes `node --check`.

Not done in this environment: pixel screenshot via headless Chromium — no
Chrome/Chromium binary is installed and the corp network blocks the bun/puppeteer
browser download. UI verified structurally instead (render inputs + DOM string
generation). A representative preview image is included (`docs/preview.png`).

---

## 8. Token usage ledger

The user asked to track token usage across runs and aggregate. There was **no
pre-existing context/token ledger** in the workspace, so this is Run 1 and it
establishes the ledger. Update this table at the end of each future run.

| Run | Date | Scope | Est. tokens (this run) | Cumulative |
|----:|------|-------|-----------------------:|-----------:|
| 1 | 2026-08-12 | Initial build: backend + discovery + Slack + themed UI + this doc | ~118,000 | ~118,000 |
| 2 | 2026-08-12 | Add Precommit PC lane (Harbinger-12 `Precommit_PC`, versioned discovery rule); fix run-dir guidance | ~28,000 | ~146,000 |
| 3 | 2026-08-12 | Bind `0.0.0.0` + EADDRINUSE handling; embed assets + in-house bundler; portable SEA binary + build scripts; `PIPELINE-DESIGN.md`; `.gitignore` | ~46,000 | ~192,000 |
| 4 | 2026-08-12 | Master section regrouped: msp-master group (Precommit + Local LCC + GLCC) vs standalone LKG; synthesize Precommit master from newest version; patch-release side-by-side comparison with two version dropdowns; firewalld port opened | ~40,000 | ~232,000 |
| 5 | 2026-08-12 | Patch-release default = last two trains (left N-1 newest e.g. 7.5.2, right N newest e.g. 7.6.9.3); exclude vanguard `.99`/`88` builds from defaults; rebuild+redeploy binary | ~15,000 | ~247,000 |
| 6 | 2026-08-12 | Each patch version column always shows 3 canonical lanes (msp-precommit, Local LCC, LKG) with N/A placeholders for missing jobs; rebuild+redeploy binary | ~14,000 | ~261,000 |
| 7 | 2026-08-12 | Relocated codebase to `Nutanix/github/tools/pipeline-dashboard`; Precommit master repointed to real job `sb-prod-controller-3 / Nupipe/Precommit_NOS/msp-master` (added `sbprod3` controller, new `precommit-master` rule, dropped synthesize-from-latest); fixed duplicate `devDependencies` in package.json; docs updated. NOTE: shell/exec environment was down this run — code+docs edited via file tools; live URL verify + rebuild + redeploy still pending. | ~18,000 | ~279,000 |
| 8 | 2026-08-26 | Restyled UI to the internal "Code Tracker" look (light theme, top nav, KPI strip, component pipeline timeline with stage columns), mapping existing Jenkins data + TODO placeholders for commit-flow fields; full **Go port** of the backend (`go/…`, package-for-package parity, single static `go:embed` binary replacing the Node SEA build); verified live parity vs Node on `/api/pipelines` + 9 endpoint smoke tests; added a **systemd installer** for a new host (`go/packaging/`, `make package`). | ~155,000 | ~434,000 |
| 9 | 2026-08-26 | Reorganized UI into **three tabs** (renamed *MSP Pipeline Status*): Pipeline Status (real lanes only — removed Awaiting-*/LKG-Builds/Tests columns + CFDs/Cherry-Picks tabs + V4/Post-LKG sub-tabs), **Analytics** (per-branch detailed analysis), **Alerts** (per-pipeline alert count + frequency). Added **persistent alert history** (`data/alert-state.json` `history` map) recorded on alert-fire in both backends + new `GET /api/alerts` (count, perDay, avgGapHours, last7/30Days); synced embed assets, `go vet`/build clean, verified `/api/alerts` frequency math with synthetic + live smoke test. | ~70,000 | ~504,000 |
| 10 | 2026-08-31 | Restored repo context; live-verified Controller-3 `msp-master` (anon HTTP 200). Added `SLACK_ENABLED` pause switch (Go + Node): `false` logs only and does not consume cooldown. Documented install-on-another-host + start/pause Slack in `README.md` §A/§B, `PIPELINE-CONTEXT.md` §4, and `go/packaging/README.txt`. | ~35,000 | ~539,000 |
| 11 | 2026-09-01 | Slack `/api/digest/test` now always posts (failure digest or all-clear) and returns `reason`/`channel`/`hasBotToken`. Code Tracker UI: dropped branch-page Cherry-Pick View + Analytics buttons and V4/Post-LKG sub-tabs; CFDs / Analytics / Cherry-Picks stay empty. | ~45,000 | ~584,000 |
| 12 | 2026-09-01 | Master KPI links to master LKG (not newest patch). Added Smoke column (Controller-1 `Postcommit`). Renamed AWAITING LCC → Precommit pipeline. Master LKG as a full column. Discover Controller-1 LKG so 7.7 appears. | ~40,000 | ~624,000 |
| 13 | 2026-09-03 | 10-fail Slack alert now includes the dashboard link + Block Kit (same shape as the 09:00 digest). | ~12,000 | ~636,000 |

Notes on the Run 1 estimate: this counts the full agent session — reading skills
and workspace, ~30 live Jenkins/Slack probe commands, authoring ~10 files
(server + public + docs), live end-to-end testing, and debugging the background
process launch. It is an approximation (the harness does not expose an exact
counter to the agent); treat ±15% as the confidence band. **For an exact figure,
read the token count the CLI/host reports for this session and replace the
estimate above**, then carry the corrected cumulative forward.

### How to update next run
1. Open this table.
2. Add a new row with the run's date, a one-line scope, and its token cost.
3. Set `Cumulative` = previous cumulative + this run.
