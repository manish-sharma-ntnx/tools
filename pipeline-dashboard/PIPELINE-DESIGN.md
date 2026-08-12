# MSP Pipeline Dashboard — Design Document

Technical design of the pipeline-tracking dashboard: data flow, components,
polling model, version discovery, alerting, and the portable build. See
`PIPELINE-CONTEXT.md` for the rationale/decision log and token ledger.

---

## 1. Goals & constraints

| Goal | How it shapes the design |
|---|---|
| Track Devtest, Precommit PC, Master, and Patch-release pipelines | One normalized "pipeline card" model regardless of source controller |
| Read-only Jenkins access | Anonymous JSON API only; no writes, no credentials shipped |
| Auto-pick up new patch versions | Folder-listing + regex discovery, refreshable on demand |
| Alert when a pipeline fully fails (last 10) | Streak detection in the poll loop → Slack with cooldown |
| Leadership-grade UI | Themed SPA, version blocks, sparklines, KPIs |
| Portable, runs on an old dev VM | Single self-contained executable (Node SEA); assets embedded |
| Serve to other machines | Bind `0.0.0.0`; browser on any host hits `http://<vm-ip>:PORT` |

---

## 2. System architecture

```
                          ┌────────────────────────────────────────────┐
                          │            Portable executable               │
                          │        (Node runtime + app, 1 file)          │
   Browsers on other      │                                              │
   machines (LAN)         │   ┌──────────┐   poll    ┌───────────────┐   │
        │  HTTP           │   │  HTTP     │──────────▶│  Poll engine  │   │      Jenkins JSON API
        └────────────────▶│   │  server   │           │  (store.js)   │───┼──▶  (read-only, anon)
   GET /                  │   │ (index.js)│◀──────────│               │   │   ┌───────────────────┐
   GET /api/pipelines     │   └────┬──────┘  snapshot └──┬────────┬───┘   │   │ Devtest 10.37...   │
   POST /api/refresh      │        │                     │        │       │   │ SB Prod ctrl-2     │
                          │   embedded assets       discovery   slack     │   │ Harbinger-14 (LKG) │
                          │   (assets.js)          (discovery)  (slack)   │   │ Harbinger-12 (PC)  │
                          │                                       │       │   └───────────────────┘
                          └───────────────────────────────────────┼──────┘
                                                                   ▼
                                                       Slack #test-msp (@msp-help)
```

- **Single process.** No DB, no external services. State is an in-memory snapshot
  plus a tiny `data/alert-state.json` for alert cooldowns.
- **Server-side fan-out.** The browser never talks to Jenkins; it reads one
  pre-computed snapshot. This protects the read-only controllers and gives every
  viewer a consistent picture.

---

## 3. Component design

| File | Responsibility |
|---|---|
| `server/config.js` | Controllers, discovery rules, Slack + runtime settings. The single place to add a lane/controller. |
| `server/jenkins.js` | HTTP JSON client (per-host TLS policy), folder listing, per-job fetch, bounded-concurrency map. |
| `server/discovery.js` | Version discovery via regex over folder jobs; semantic version compare/sort; train grouping. |
| `server/store.js` | Poll loop: fetch → normalize → last-10 math → assemble version blocks → run alert rule → publish snapshot. |
| `server/slack.js` | Failure alert formatting + webhook/bot transport + per-pipeline cooldown + persisted state. |
| `server/assets.js` | Serve UI from embedded bundle (portable) or disk (dev). |
| `server/index.js` | HTTP server: `/api/*` + static; host binding; `EADDRINUSE` handling; poll scheduler. |
| `public/*` | Vanilla SPA (index.html, styles.css, app.js, favicon.svg). |
| `scripts/build.js` | Inline assets + bundle CommonJS graph → `dist/bundle.js`. |
| `scripts/package-sea.sh` | Build the single portable executable via Node SEA + postject. |

---

## 4. Data model

### Pipeline "meta" (what to fetch) — produced by config + discovery
```
{ key, controller, path:[folder…,job], lane, version, title, subtitle }
```

### Pipeline "card" (normalized status) — produced by store.js
```
{
  key, title, subtitle, lane, version, controller, url, category,
  status: success|failed|running|unstable|aborted|unreachable|unknown,
  reachable, builds:[{number,status,result,building,timestamp,duration,url}…10],
  lastBuildNumber, lastTimestamp,
  successRate, completedCount, consecutiveFailures, allFailing,
  health:{score,description}|null
}
```

### Snapshot (what the API returns)
```
{ generatedAt, stats, static:[card…], versionBlocks:[{version,train,isMaster,pipelines:[card…]}…], discoveryErrors, alerts }
```

Status normalization maps Jenkins `result`+`building`+`color` → our vocabulary
(`normalizeStatus`). `_anime` colors and `result:null` mean **running**.

---

## 5. Polling model

- Every `POLL_INTERVAL_MS` (default 180s) the poll engine:
  1. Ensures discovery is fresh (re-listed if older than 30 min or forced).
  2. Fetches every job with `tree=…builds[…]{0,10}…` at concurrency 8.
  3. Normalizes to cards, computes success rate + failure streak.
  4. Assembles the Master block + one block per version (newest first).
  5. Evaluates the alert rule and (maybe) posts to Slack.
  6. Atomically swaps the in-memory `SNAPSHOT`.
- The UI polls `/api/pipelines` every 60s and re-renders. Cold start triggers an
  on-demand poll so the first request is never empty.

---

## 6. Version discovery (the moving part)

Patch pipelines are siblings of `master`/precommit jobs inside a known folder,
with the version encoded in the job name. Discovery = list folder + regex.

| Lane | Controller / folder | Job pattern | Version regex |
|---|---|---|---|
| Local LCC | SB Prod / `Nupipe/LCC_NOS` | `msp-master`, `msp-ganges-<v>` | `^msp-ganges-(\d+(?:\.\d+)*)$` |
| GLCC | SB Prod / `Nupipe/LCC_Dial_Tests` | `msp-master`, `msp-ganges-<v>` | `^msp-ganges-(\d+(?:\.\d+)*)$` |
| Precommit PC | Harbinger-12 / `Nupipe/Precommit_PC` | `msp-ganges-<v>-pc` | `^msp-ganges-(\d+(?:\.\d+)*)-pc$` |
| LKG | Harbinger-14 / `Nupipe/LKG` | `master`, `ganges-<v>-stable` | `^ganges-(\d+(?:\.\d+)*)-stable$` |

- Versions are 2–4 segments (`7.6` … `7.6.9.3`), compared numerically per segment.
- Blocks are grouped by exact version, tagged with their **train** (`major.minor`),
  sorted newest-first; older blocks render collapsed.
- **"Fetch latest releases"** (`POST /api/refresh`) forces a re-list so brand-new
  `…-<newver>` jobs appear with zero code change.

Adding a lane/controller = one entry in `CONTROLLERS` + one `DISCOVERY_RULES` entry.

### Master section grouping
Per the pipeline semantics, Precommit + Local LCC + GLCC are stages of the same
`msp-master` pipeline, while LKG is a separate mainline. The UI reflects this:

- Each discovery rule carries a `masterGroup` tag (`msp-master` or `lkg`).
- The **Master** section renders two cards: an **msp-master** group card
  (Precommit, Local LCC, GLCC — ordered by lane) and a standalone **LKG master**.
- Precommit PC has no real `master` job, so the store **synthesizes** a
  "Precommit (latest N.N.N.N)" master from the newest discovered precommit version
  (`synthesizeMasterFromLatest` in config → `discovery.js`). It updates
  automatically as new precommit versions land.

### Patch-release comparison
The Patch Releases section is a **two-column side-by-side comparator**: each column
has a version dropdown (all discovered patch versions, newest first). Selecting
versions renders both blocks' lane cards next to each other for direct comparison.
**Fixed three lanes per version.** Each selected version column always shows the
three canonical lanes in order: **msp-precommit** (Harbinger-12 `Precommit_PC`),
**Local LCC** (SB Prod `LCC_NOS`), and **LKG** (Harbinger-14 `LKG`). If a lane has
no Jenkins job at the selected version (e.g. no `msp-ganges-7.6.9.3` under LCC_NOS),
it renders as a dashed **N/A placeholder** so the comparison stays aligned and
honest rather than silently dropping the lane.

**Default selection = last two major trains:** right column = newest version of the
latest train (N, e.g. `7.6.9.3` on the `7.6` train), left column = newest version of
the previous train (N-1, e.g. `7.5.2` on the `7.5` train). Vanguard/dev builds
(trailing `.99`, or `88` like `7.5.99` / `8.88`) are excluded from defaults but
remain selectable. Selection is client-side only (no API change); each column reuses
the same normalized pipeline cards.

---

## 7. Alerting design

- **Trigger:** a card's last 10 *completed* builds contain zero successes
  (`allFailing`). In-progress builds at the head are skipped so a running build
  can't mask the streak.
- **Message:** pipeline title, version, lane, latest build #, Jenkins deep link;
  posted to `#test-msp` tagging `@msp-help`.
- **Transport priority:** `SLACK_WEBHOOK_URL` → `SLACK_ALERT_BOT_TOKEN`
  (`chat.postMessage`) → log-only (never silently dropped).
- **Anti-spam:** per-pipeline cooldown (`SLACK_COOLDOWN_MS`, default 6h) persisted
  in `data/alert-state.json` so a long-red pipeline alerts once per window.

---

## 8. Portable build design

The dev VM's system Node is v10 (no `fetch`, old syntax). To run anywhere without
installing Node, the app ships as a **Single Executable Application (SEA)**:

```
scripts/build.js        →  dist/embedded-assets.js   (public/* as base64 map)
                        →  dist/bundle.js            (whole CommonJS graph, 1 file)
scripts/package-sea.sh  →  node --experimental-sea-config → dist/sea-prep.blob
                        →  copy `node` → dist/msp-pipeline-dashboard
                        →  postject injects blob into the copy
                        →  dist/msp-pipeline-dashboard  (single portable ELF)
```

Key design points:
- **Assets are embedded** (base64) so the binary needs no sibling `public/`
  directory — `assets.js` reads from the bundle when present, disk otherwise.
- **Tiny in-house bundler** inlines only relative `require()`s into a module
  registry; Node core modules stay as real requires. No webpack/esbuild dependency.
- **Build uses a modern Node** (v20+); the *output* binary carries its own runtime,
  so the target VM's old Node is irrelevant.
- Produced binary is arch/OS-specific (built on x86-64 Linux → runs on x86-64
  Linux). Rebuild on the matching platform for others.

### Run modes
```
# Dev (needs modern node on PATH):
node server/index.js

# Portable binary (no node needed on target):
PORT=4317 ./dist/msp-pipeline-dashboard
```

Both bind `0.0.0.0` by default → open `http://<vm-ip>:4317` from any machine on
the network. Set `HOST=127.0.0.1` to restrict to localhost.

---

## 9. Failure handling

| Failure | Behavior |
|---|---|
| A controller is down / slow | That job's card = `unreachable`; rest of dashboard unaffected |
| TLS internal cert | Per-host `insecure` flag (only the two prod controllers) |
| Port already in use | Clear `EADDRINUSE` message with remediation, exit 1 |
| No Slack transport | Alert logged, not dropped |
| Snapshot older than 5 min | Header flips Live → Stale |
| New/renamed version jobs | Picked up on next discovery or via Refresh |

---

## 10. Extensibility checklist

- **New patch train (e.g. 7.7):** nothing to do — auto-discovered.
- **New lane/controller:** add to `CONTROLLERS` + `DISCOVERY_RULES` in `config.js`.
- **Change alert channel/mention/cooldown:** env vars, no code.
- **New static (non-versioned) pipeline:** one entry in `STATIC_PIPELINES`.
- **Rebuild portable binary:** `bash scripts/package-sea.sh`.
