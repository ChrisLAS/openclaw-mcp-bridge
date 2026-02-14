# openclaw-mcp-bridge

OpenClaw plugin that bridges any Streamable HTTP MCP server as native OpenClaw tools. One plugin, unlimited MCP servers.

This is the missing piece between **OpenClaw + Ollama** and the **MCP ecosystem**. Without it, OpenClaw ignores MCP servers entirely. With it, every MCP tool becomes a tool Ollama can call.

## Why This Exists

OpenClaw has a powerful plugin system for registering tools, but no built-in MCP client. MCP servers expose tools over Streamable HTTP with a standard protocol. This plugin:

1. Connects to your MCP HTTP servers at startup
2. Discovers their tools via `tools/list`
3. Registers each as a native OpenClaw tool with proper name, description, and schema
4. Routes tool calls from Ollama → HTTP → MCP server → API → result → Ollama

The model never knows it's calling an external service. It just sees tools.

## Architecture

```
User (Telegram)
    │
    ▼
OpenClaw (Ollama llama3.3:70b)
    │
    ├── Built-in tools (browser, exec, memory, etc.)
    │
    └── openclaw-mcp-bridge plugin
            │
            ├── notion-mcp-remote   :8001  →  Notion API (OAuth)
            ├── gmail-mcp-remote    :8002  →  Gmail API (OAuth)
            └── calendar-mcp-remote :8003  →  Calendar API (OAuth)
```

## How It Works

### 1. Plugin Registration

On OpenClaw startup, the plugin:

```
for each MCP server in config:
    POST {server}/mcp → { method: "tools/list" }
    ← receives tool definitions (name, description, inputSchema)

    for each tool:
        api.registerTool({
            name: "{prefix}_{tool.name}",
            description: tool.description,
            inputSchema: tool.inputSchema,
            execute: (params) → POST {server}/mcp → { method: "tools/call", params }
        })
```

### 2. Tool Call Flow

```
Ollama: "I'll call notion_search with query='SOPs'"
    │
    ▼
openclaw-mcp-bridge: POST http://localhost:8001/mcp
    Body: {
        "jsonrpc": "2.0",
        "method": "tools/call",
        "params": { "name": "search", "arguments": { "query": "SOPs" } }
    }
    │
    ▼
notion-mcp-remote: executes search with user's OAuth token
    │
    ▼
Returns results → bridge formats → Ollama summarizes for user
```

### 3. Per-User Context

MCP servers handle OAuth per-user. The bridge must pass user identity so the MCP server uses the correct token:

```
Telegram user 12345 sends message
    → OpenClaw session has user context
    → Bridge includes user ID in MCP request headers
    → MCP server looks up OAuth token for user 12345
    → API call uses that user's credentials
```

## Configuration

In `~/.openclaw/openclaw.json`:

```json5
{
  "plugins": {
    "enabled": true,
    "entries": {
      "openclaw-mcp-bridge": {
        "config": {
          "servers": [
            {
              "name": "notion",
              "url": "http://localhost:8001",
              "prefix": "notion",
              "healthCheck": true
            },
            {
              "name": "google",
              "url": "http://localhost:8002",
              "prefix": "google",
              "healthCheck": true
            }
          ],
          "timeout": 30000,
          "retries": 1
        }
      }
    }
  }
}
```

### Config Fields

| Field | Type | Description |
|-------|------|-------------|
| `servers[].name` | string | Human-readable name for logging |
| `servers[].url` | string | Base URL of the MCP HTTP server |
| `servers[].prefix` | string | Tool name prefix (e.g., `notion` → `notion_search`, `notion_create_page`) |
| `servers[].healthCheck` | boolean | Check `/health` on startup, skip server if down |
| `timeout` | number | HTTP request timeout in ms (default: 30000) |
| `retries` | number | Retry count on transient failures (default: 1) |

## Tool Naming

MCP servers expose tools with generic names (`search`, `create_page`). Multiple servers would collide. The bridge prefixes each tool with the server's configured prefix:

| MCP Server | MCP Tool Name | OpenClaw Tool Name |
|------------|---------------|-------------------|
| notion-mcp-remote | `search` | `notion_search` |
| notion-mcp-remote | `create_page` | `notion_create_page` |
| gmail-mcp-remote | `search_emails` | `google_search_emails` |
| calendar-mcp-remote | `create_event` | `google_create_event` |

Ollama sees a flat list of uniquely-named tools with descriptions. It picks the right one.

## What This Enables

### The Full User Experience

1. User clicks `t.me/YourBotName` on a landing page
2. Sends `/start` — OpenClaw responds, runs personality setup
3. "Let's connect your apps" — sends OAuth links as Telegram buttons
4. User authorizes Notion, Gmail, Calendar
5. User chats naturally:

```
User: "What's on my calendar tomorrow?"
Bot: [calls google_list_events] You have 3 meetings:
     - 9am: Standup
     - 1pm: Design review
     - 3pm: Coffee with Sarah

User: "Move the coffee to 4pm"
Bot: [calls google_update_event] Done! Moved to 4pm.

User: "Draft a note about design review decisions in Notion"
Bot: [calls notion_create_page] Created "Design Review Notes"
     in your Daily Notes database.

User: "Email Sarah that coffee is at 4 now"
Bot: [calls google_send_email] Sent to sarah@example.com:
     "Hey Sarah, pushed our coffee to 4pm. See you then!"
```

All powered by Ollama running locally. $0/month.

### For the OpenClaw Community

Any OpenClaw user can connect any MCP server:
- Notion, Gmail, Calendar (our servers)
- GitHub MCP, Slack MCP, Linear MCP (community servers)
- Any custom MCP server following the Streamable HTTP spec

One plugin. Unlimited integrations.

## Development

### Prerequisites

- Node.js >= 22
- An OpenClaw installation (v2026.2.x+)
- At least one MCP HTTP server running locally

### Setup

```bash
git clone https://github.com/ldraney/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
pnpm install
pnpm build
```

### Local Development

```bash
# Terminal 1: Start an MCP server (e.g., notion-mcp-remote)
cd ~/notion-mcp-remote && make run

# Terminal 2: Link plugin to OpenClaw
cd ~/openclaw-mcp-bridge && pnpm link --global
cd ~/openclaw && pnpm link --global openclaw-mcp-bridge

# Terminal 3: Start OpenClaw with plugin
openclaw gateway --verbose
```

### Testing

```bash
# Unit tests (mock HTTP)
pnpm test

# Integration test (requires running MCP server)
pnpm test:integration
```

## Project Structure

```
openclaw-mcp-bridge/
├── src/
│   ├── index.ts          # Plugin entry: register(), activate()
│   ├── discovery.ts      # tools/list fetcher, schema parser
│   ├── bridge.ts         # Tool wrapper: MCP HTTP call + response formatting
│   ├── config.ts         # Plugin config types and validation
│   └── health.ts         # Health check logic
├── tests/
│   ├── discovery.test.ts
│   ├── bridge.test.ts
│   └── integration.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Related Repos

| Repo | Role |
|------|------|
| [ldraney/openclaw](https://github.com/ldraney/openclaw) | OpenClaw fork — Telegram frontend + Ollama |
| [ldraney/notion-mcp-remote](https://github.com/ldraney/notion-mcp-remote) | Notion MCP with OAuth over Streamable HTTP |
| [ldraney/gmail-mcp](https://github.com/ldraney/gmail-mcp) | Gmail MCP server (needs remote wrapper) |
| [ldraney/calendar-mcp](https://github.com/ldraney/calendar-mcp) | Calendar MCP server (needs remote wrapper) |
| [ldraney/dev-sop-engine](https://github.com/ldraney/dev-sop-engine) | SOP-driven .claude/ config generator |

## Open Questions

- **Auth header format**: How should user identity be passed to MCP servers? Custom header (`X-OpenClaw-User`)? Bearer token? Session cookie?
- **Tool caching**: Should tool definitions be cached, or re-fetched on each OpenClaw restart?
- **Streaming**: MCP supports streaming responses. Should the bridge support streaming back to Ollama, or buffer the full response?
- **Error UX**: When an MCP server is down, should the tool return an error to Ollama, or should the bridge deregister the tools entirely?
- **Google OAuth shared flow**: gmail-mcp-remote and calendar-mcp-remote share one Google OAuth. Should the bridge know about this (one "Connect Google" button) or should each MCP server handle it independently?

## License

MIT
