import json
import requests
from server import MCPClient, MCP_BASE_URL, JIRA_FILTER_ONCALL, JIRA_FIELDS

mcp = MCPClient(MCP_BASE_URL)
mcp.connect()

payload = {
    "jsonrpc": "2.0",
    "id": mcp._next_id(),
    "method": "tools/call",
    "params": {"name": "atlassian__jira_search", "arguments": {
        "jql": JIRA_FILTER_ONCALL,
        "fields": JIRA_FIELDS,
        "limit": 1,
        "start_at": 0,
    }},
}

r = requests.post(mcp.base_url, json=payload, timeout=120, headers=mcp._headers())
data = mcp._parse_sse(r.text)
if not data: data = json.loads(r.text)
content = data.get("result", {}).get("content", [])
txt = content[0]["text"]

print("--- RAW JSON FROM MCP SERVER ---")
print(txt[:1000])
