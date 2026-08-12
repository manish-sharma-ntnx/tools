# MSP Engineering ONCALL Dashboard — Project Context

## Overview

A **live, auto-refreshing dashboard** for Jira filters tracking MSP Engineering tickets. The current production setup is a **FastAPI backend that serves a self-contained, single-page `dashboard.html`** (Chart.js + vanilla JS). Data is fetched from Jira via the Atlassian MCP bridge every 30 minutes.

Currently tracks three primary filters:
- **ONCALLs**: Filter [#174525](https://jira.nutanix.com/issues/?filter=174525)
- **Top CFDs**: Filter [#181164](https://jira.nutanix.com/issues/?filter=181164)
- **Top CFIs**: Filter [#181165](https://jira.nutanix.com/issues/?filter=181165)

**Dashboard URL:** `http://manish-sharma.r8.ubvm.nutanix.com:8050/`

> The legacy Streamlit frontend (`streamlit_app.py`, port 8051) still ships in the repo but is **not the active dashboard**. It is currently broken (Plotly `px.bar` "list of column references" error in `top_n_chart`, see `streamlit.log`) and the process is not running. The primary UI is now the static HTML served by FastAPI at `/`.

---

## Current Runtime Status (as observed)

| Component | Port | Status |
|-----------|------|--------|
| FastAPI backend (`server.py`) | 8050 | **Running** (pid `1808204`, `python3.9 server.py`, up since Jun 21) |
| `GET /` (dashboard.html) | 8050 | **200 OK** |
| `GET /api/data` | 8050 | **200 OK** |
| Streamlit frontend (`streamlit_app.py`) | 8051 | **Not running** (last run crashed with Plotly error, killed) |

Latest successful refresh in `server.log`:
- ONCALLs: **891 issues** (222 with affects-version data)
- CFDs: **417 issues** (121 with affects-version data)
- CFIs: **99 issues** (11 with affects-version data)

---

## Architecture

```
Browser ──GET / ─────────────────>  FastAPI (server.py :8050) ──serves──> dashboard.html
Browser ──GET /api/data ─────────>  FastAPI (server.py :8050) ──MCP─────> Jira Filters
                                          │
                                          └── Background thread refreshes cache every 30 min
```

### Data Flow

1. **Background thread** in `server.py` runs every 30 min (and once at startup)
2. Connects to the **Atlassian MCP server** at `https://panacea-dev.eng.nutanix.com/mcp/atlassian` using the MCP Streamable-HTTP protocol (JSON-RPC over SSE). Auth headers are loaded from `~/.cursor/mcp.json` → `mcpServers.atlassian.headers`.
3. Calls `jira_search` tool with the three filters (`174525`, `181164`, `181165`), paginating 50 issues at a time
4. Calls `jira_search` with targeted `affectedVersion = "X"` JQL for 31 major version patterns to build the Affects Version/s mapping (since the MCP tool doesn't expose the `versions` field per-issue)
5. Processes all issues into lightweight JSON rows and caches in memory
6. The browser fetches `/api/data` and the embedded JS in `dashboard.html` renders all widgets, tabs, time-range filters, and tables using Chart.js — no further server round trips per interaction.

### Key Technical Decisions

- **Self-contained HTML frontend**: The active UI is a single `dashboard.html` file (Chart.js via CDN, vanilla JS) served by FastAPI. Removes the Streamlit dependency for the live dashboard and reduces per-interaction latency.
- **Streamlit kept as legacy**: `streamlit_app.py` and `start_streamlit.sh` remain in the repo but are not part of the running stack and are currently broken.
- **MCP bridge for Jira auth**: Jira at `jira.nutanix.com` requires authentication. The Atlassian MCP server at `panacea-dev.eng.nutanix.com/mcp/atlassian` handles all auth. The dashboard server talks to Jira exclusively through MCP tool calls. Auth headers are read from the user's Cursor MCP config (`~/.cursor/mcp.json`).
- **Affects Version/s workaround**: The MCP Atlassian tool does NOT return the standard Jira `versions` (Affects Version/s) field in its serialized output. As a workaround, `server.py` runs JQL count queries like `filter=174525 AND affectedVersion = "pc.2024.2"` for each major version pattern and maps results back to issue keys.

---

## Files

| File | Purpose |
|------|---------|
| `server.py` | FastAPI backend — MCP client, Jira data fetcher, affects-version resolver, in-memory cache, API endpoints, serves `dashboard.html` at `/` |
| `dashboard.html` | **Active frontend** — single-page Chart.js dashboard, fetches `/api/data` and renders all tabs/widgets client-side |
| `streamlit_app.py` | **Legacy** Streamlit frontend (currently broken, not running) |
| `requirements.txt` | Python dependencies: `fastapi`, `uvicorn[standard]`, `requests`, `apscheduler` (Streamlit/Pandas/Plotly are not listed but are needed by the legacy frontend if used) |
| `start.sh` | Helper script to launch the FastAPI server |
| `start_streamlit.sh` | Helper script to launch the legacy Streamlit frontend |
| `test_mcp.py` | Ad-hoc script to sanity-check the MCP connection |
| `server.log`, `server.log.old`, `server.log.prev2` | Backend logs (current + rotations) |
| `streamlit.log`, `streamlit.log.old`, `streamlit.log.prev2` | Legacy Streamlit logs |

---

## API Endpoints (FastAPI)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves `dashboard.html` |
| `GET` | `/api/data` | Returns the cached payload. `202` with `{status: "loading"\|"error"}` while the initial fetch is in progress or if MCP is failing. |
| `POST` | `/api/refresh` | Triggers an immediate background refresh. |

---

## Dashboard Tabs

The dashboard is split into three main tabs, each driven by a different Jira filter:
- **ONCALLs** (Filter 174525)
- **Top CFDs** (Filter 181164)
- **Top CFIs** (Filter 181165)

## Dashboard Sections (widgets per tab)

1. **Monthly Trend** — Line chart showing ticket volume per month
2. **Open vs Closed per Month** — Dual line chart
3. **SF Cases per Month** — Line chart
4. **Top Fix Version/s** — Horizontal bar chart
5. **Top Affects Version/s** — Horizontal bar chart
6. **Priority & Resolution Distribution (Section 2c)** — Three doughnut charts side-by-side:
   - **Priority Distribution (All)** — P0/P1/P2/P3/P4 across all issues in the selected time range
   - **Priority Distribution (Currently Open)** — Same priority breakdown but restricted to issues where `is_open=true`; title shows the live open count (e.g. "Priority Distribution (137 Currently Open)")
   - **Resolution breakdown** — Resolution field distribution across closed tickets (Fixed / Won't Fix / Duplicate / etc.)
7. **Top Components** — Horizontal bar chart
8. **Top Impacts** — Horizontal bar chart
9. **Top Reporters** — Horizontal bar chart
10. **Top Labels** — Horizontal bar chart
11. **Labels per Month** — Stacked bar chart + Line overlay

### Tables

- **Tickets with High Salesforce Cases Attached** — Sorted by `sf_cases` descending
- **High Impact (P0/P1/P2)** — Filtered to critical priorities within the selected time range
- **Currently Open** — All issues where status is not Done/Closed/Resolved
- **All in Selected Range** — Full list for the selected time window

### Time-Range Filter

A control bar in `dashboard.html` filters all widgets simultaneously:
- Last 1 Qtr (3 months)
- Last 2 Qtrs (6 months)
- Last 3 Qtrs (9 months)
- **Last 1 Year** (default)
- Last 2 Years
- All Time

---

## Jira Fields Used

| Field | Jira Field ID | Usage |
|-------|---------------|-------|
| Summary | `summary` | Issue title in all tables |
| Status | `status` | Open/Closed determination; status badges |
| Created | `created` | Monthly trend; time-range filtering |
| Updated | `updated` | Recency display |
| Priority | `priority` | Priority chart; high-impact filtering (P0/P1/P2) |
| Assignee | `assignee` | Displayed in tables |
| Reporter | `reporter` | Top reporters chart |
| Components | `components` | Top components chart |
| Fix Version/s | `fixVersions` | Fix Version chart |
| Affects Version/s | `versions` (via JQL workaround) | Affects Version chart |
| Labels | `labels` | Labels chart |
| Resolution | `resolution` | Status classification |
| # SF Cases | `customfield_12364` | Salesforce case count badge |
| Impact | `customfield_10011` | Top Impacts chart |

### Open/Closed Logic

An issue is considered **open** if:
- Status name is NOT in: `{Closed, Resolved, Done, Complete, Cancelled}`
- Status category is NOT in: `{Done, Complete}`

---

## MCP Protocol Details

The server uses the **MCP Streamable-HTTP transport** to talk to the Atlassian MCP server:

1. **Initialize**: `POST /mcp` with `method: "initialize"` — returns `Mcp-Session-Id` header
2. **Notify**: `POST /mcp` with `method: "notifications/initialized"`
3. **Call tools**: `POST /mcp` with `method: "tools/call"`, `params: {name, arguments}`
4. **Parse response**: Server returns SSE (`text/event-stream`), parse `data:` lines as JSON-RPC

Auth headers (e.g. bearer token) are loaded at process start from:
```
~/.cursor/mcp.json  →  mcpServers.atlassian.headers
```

Key MCP tools used:
- `jira_search` — paginated issue search with JQL
- `jira_get_project_versions` — list all versions in the ONCALL project (used to seed the affects-version sweep)

---

## Server Management

```bash
# Start FastAPI Server (serves both API + dashboard.html)
cd ~/Nutanix/github/oncall_dashboard && nohup python3.9 server.py > server.log 2>&1 &

# Check it's up
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8050/        # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8050/api/data # 200 (or 202 while loading)

# Force a refresh
curl -X POST http://localhost:8050/api/refresh

# Tail logs
tail -f server.log

# (Legacy only — currently broken) Start Streamlit
cd ~/Nutanix/github/oncall_dashboard && nohup ./start_streamlit.sh > streamlit.log 2>&1 &
```

### Configuration (top of `server.py`)

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_BASE_URL` | `https://panacea-dev.eng.nutanix.com/mcp/atlassian` | Atlassian MCP endpoint |
| `JIRA_FILTER_ONCALL` | `filter=174525 ORDER BY created DESC` | ONCALLs JQL |
| `JIRA_FILTER_CFD` | `filter=181164 ORDER BY created DESC` | Top CFDs JQL |
| `JIRA_FILTER_CFI` | `filter=181165 ORDER BY created DESC` | Top CFIs JQL |
| `PAGE_SIZE` | `50` | Issues per API page |
| `REFRESH_INTERVAL_SECONDS` | `1800` (30 min) | Auto-refresh interval |
| `SERVER_PORT` | `8050` | HTTP port for backend + dashboard |

### Firewall

Port 8050 must be open (8051 only needed if running the legacy Streamlit UI):
```bash
sudo firewall-cmd --add-port=8050/tcp --permanent
sudo firewall-cmd --add-port=8051/tcp --permanent   # optional, legacy
sudo firewall-cmd --reload
```

---

## Known Issues

- **Streamlit frontend is broken**: `streamlit_app.py:84` calls `px.bar(x=counts.values, y=counts.index, ...)` which raises `ValueError: Cannot accept list of column references or list of columns for both x and y` on the current Plotly version. The active dashboard is unaffected since it uses `dashboard.html` instead. Fix would be to pass a DataFrame and named columns, or coerce `counts.values` to a list.
- **`requirements.txt` is incomplete for the legacy UI** — it lists only `fastapi`, `uvicorn[standard]`, `requests`, `apscheduler`. If you want to run `streamlit_app.py` you must also install `streamlit`, `pandas`, `plotly` manually.

---

## Runtime Environment

- **Host**: `manish-sharma.r8.ubvm.nutanix.com` (Linux 5.10, RHEL 8)
- **Python**: 3.9 (`/usr/bin/python3.9`)
- **Active dependencies**: `fastapi`, `uvicorn[standard]`, `requests`, `apscheduler`
- **Legacy dependencies (Streamlit UI)**: `streamlit`, `pandas`, `plotly`
- **Backend + dashboard port**: 8050
- **Legacy frontend port**: 8051 (not in use)
