# MSP Engineering ONCALL Dashboard

A **live, auto-refreshing dashboard** for tracking MSP Engineering ONCALL tickets. Built with a **FastAPI backend** + **Streamlit frontend**, it fetches data from Jira via the Atlassian MCP bridge every 30 minutes.

**Dashboard URL:** `http://manish-sharma.r8.ubvm.nutanix.com:8051`

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                     │
│  Streamlit App (Interactive tabs, Plotly charts, dynamic data tables)    │
│                                                                          │
└─────────┬───────────────────────────────────────────────────────────────┘
          │
          │  GET /           → serves Streamlit App (port 8051)
          │
┌─────────▼───────────────────────────────────────────────────────────────┐
│                 STREAMLIT FRONTEND (streamlit_app.py :8051)               │
│                                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────────┐  │
│  │ Time-Range   │   │ Plotly       │   │ Pandas DataFrames           │  │
│  │ Filter Bar   │   │ Charts       │   │ (Filterable/Sortable)       │  │
│  └──────┬───────┘   └──────────────┘   └─────────────────────────────┘  │
│         │                                                                │
│         ▼                                                                │
│   GET http://127.0.0.1:8050/api/data                                     │
└───────────────────────────────────────────────────┬─────────────────────┘
                                                    │
┌───────────────────────────────────────────────────▼─────────────────────┐
│                     FastAPI SERVER  (server.py :8050)                     │
│                                                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌─────────────────────────────┐  │
│  │ DataCache    │   │ Background   │   │ MCPClient                   │  │
│  │ (in-memory,  │◄──│ Refresh      │──►│ (Streamable-HTTP / SSE)     │  │
│  │ thread-safe) │   │ Thread       │   │                             │  │
│  └──────┬───────┘   │ (30 min)     │   │ connect() → initialize      │  │
│         │           └──────────────┘   │ call_tool() → JSON-RPC      │  │
│         ▼                              │ auto-reconnect on failure    │  │
│   /api/data returns                    └──────────┬──────────────────┘  │
│   cached JSON payload                             │                      │
└───────────────────────────────────────────────────┼─────────────────────┘
                                                    │
                     MCP Streamable-HTTP protocol    │
                     POST http://10.113.24.33:3008/mcp
                     (JSON-RPC 2.0 over SSE)         │
                                                    │
┌───────────────────────────────────────────────────▼─────────────────────┐
│              ATLASSIAN MCP SERVER  (10.113.24.33:3008)                    │
│              Handles all Jira authentication                             │
│                                                                          │
│  Tools used:                                                             │
│  ├─ jira_search(jql, fields, limit, start_at)                           │
│  └─ jira_get_project_versions(project)                                  │
└───────────────────────────────────────────────────┬─────────────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    JIRA  (jira.nutanix.com)                               │
│                    Filters: #174525, #127170, #126304                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Background thread** in `server.py` runs every 30 minutes
2. Connects to the **Atlassian MCP server** using the MCP Streamable-HTTP protocol (JSON-RPC over SSE)
3. Calls `jira_search` for ONCALLs, CFDs, and CFIs, paginating 50 issues at a time
4. Calls `jira_search` with targeted `affectedVersion = "X"` JQL for 31 major version patterns to build the Affects Version/s mapping
5. Processes all issues into lightweight JSON rows and caches in memory
6. Streamlit frontend fetches `http://127.0.0.1:8050/api/data`, receives all issue rows, and does **client-side filtering and aggregation** using Pandas.

### Key Design Decisions

- **Separation of Concerns**: The FastAPI server handles heavy MCP communication, Jira fetching, pagination, and data caching. The Streamlit server focuses purely on UI rendering, using Pandas to aggregate data locally so filter changes feel instant.
- **MCP bridge for Jira auth**: The Jira instance at `jira.nutanix.com` requires authentication. The Atlassian MCP server at `10.113.24.33:3008` handles all auth. The dashboard server talks to Jira exclusively through MCP tool calls.
- **Affects Version/s workaround**: The MCP Atlassian tool does NOT return the standard Jira `versions` (Affects Version/s) field in its serialized output. As a workaround, `server.py` runs JQL count queries like `filter=174525 AND affectedVersion = "pc.2024.2"` for each major version pattern and maps results back to issue keys.

---

## Component Breakdown

### 1. Frontend — `streamlit_app.py`

**Technology:** Streamlit, Pandas, Plotly Express/Graph Objects

**Layout:**

- **Header** — title, last-refreshed timestamp, manual refresh button
- **Time-Range Filter Bar** — Radio buttons (1Q / 2Q / 3Q / 1Y / 2Y / All Time), default = Last 1 Year
- **Tabs** — ONCALLs, Top CFDs, Top CFIs
- **5 KPI Cards** — Total, Open, Closed, High Impact (P0/P1/P2), With SF Cases
- **Charts (Plotly):**
  - Monthly Trend (line)
  - Open vs Closed per Month (dual line)
  - SF Cases per Month (line)
  - Top Fix Versions (horizontal bar)
  - Top Affects Versions (horizontal bar)
  - Priority Distribution (pie)
  - Top Components (horizontal bar)
  - Top Impacts (horizontal bar)
  - Top Reporters (horizontal bar)
  - Top Labels (horizontal bar)
  - Labels per Month (stacked bar + line)
- **4 Tables (Pandas/Streamlit DataFrame)** — filterable, sortable, and downloadable:
  - Top CFDs with High SF Cases (sorted by `sf_cases` desc)
  - High Impact ONCalls — P0/P1/P2 only
  - Currently Open ONCalls
  - All ONCalls in Selected Range

### 2. Backend — `server.py`

**Technology:** Python 3.9 + FastAPI + Uvicorn

**4 major components:**

| Component | Purpose |
|-----------|---------|
| `MCPClient` | Thin MCP Streamable-HTTP client (initialize, call_tool, SSE parsing, auto-reconnect) |
| `fetch_all_issues()` | Paginate through filters, 50 issues/page |
| `fetch_affects_version_counts()` | Query 31 `affectedVersion = "X"` JQL queries, build issue→versions map |
| `process_issues()` | Transform raw Jira responses into lightweight row dicts |

**API Endpoints:**

| Endpoint | Method | Response |
|----------|--------|----------|
| `/` | GET | (Deprecated) Used to serve `dashboard.html` |
| `/api/data` | GET | Returns cached JSON (`{oncall, cfd, cfi, last_refreshed, refresh_interval_min}`) or HTTP 202 if still loading |
| `/api/refresh` | POST | Spawns a background thread to re-fetch immediately |

---

## File Map

```
~/Nutanix/github/oncall_dashboard/
├── server.py             ← FastAPI backend — MCP client, data pipeline, API
├── streamlit_app.py      ← Streamlit Frontend — Plotly, Pandas, UI
├── requirements.txt      ← fastapi, uvicorn, requests, apscheduler
├── start.sh              ← Launch helper for FastAPI server
├── start_streamlit.sh    ← Launch helper for Streamlit app
├── CONTEXT.md            ← Project context document
├── README.md             ← This file
├── server.log            ← Runtime logs for backend
└── streamlit.log         ← Runtime logs for frontend
```

---

## Server Management

### Start Both Services

```bash
# Start FastAPI backend
cd ~/Nutanix/github/oncall_dashboard && nohup python3.9 server.py > server.log 2>&1 &

# Start Streamlit frontend
cd ~/Nutanix/github/oncall_dashboard && nohup ./start_streamlit.sh > streamlit.log 2>&1 &
```

### Stop Services

```bash
# Stop backend
kill $(pgrep -f "python3.9 server.py")

# Stop frontend
kill $(pgrep -f "streamlit run")
```

### Check Logs

```bash
tail -f ~/Nutanix/github/oncall_dashboard/server.log
tail -f ~/Nutanix/github/oncall_dashboard/streamlit.log
```

### Firewall

Ports 8050 and 8051 were opened via:

```bash
sudo firewall-cmd --add-port=8050/tcp --permanent
sudo firewall-cmd --add-port=8051/tcp --permanent
sudo firewall-cmd --reload
```

---

## Runtime Environment

| Property | Value |
|----------|-------|
| Host | `manish-sharma.r8.ubvm.nutanix.com` |
| OS | Linux 5.10 / RHEL 8 |
| Python | 3.9.25 (`/usr/bin/python3.9`) |
| Backend Port | 8050 |
| Frontend Port | 8051 |
| MCP endpoint | `http://10.113.24.33:3008/mcp` |

### Dependencies

```bash
python3.9 -m pip install --user fastapi uvicorn requests apscheduler streamlit pandas plotly
```