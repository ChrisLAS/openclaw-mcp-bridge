# openclaw-mcp-bridge

OpenClaw plugin that bridges any Streamable HTTP MCP server as native OpenClaw tools. One plugin, unlimited MCP servers.

## Why This Exists

OpenClaw has a powerful plugin system for registering tools, but no built-in MCP client. MCP servers expose tools over Streamable HTTP with a standard protocol. This plugin:

1. Connects to your MCP HTTP servers at startup
2. Discovers their tools via `tools/list` (with MCP `initialize` handshake)
3. Registers each as a native OpenClaw tool with proper name, description, and schema
4. Routes tool calls from the model via HTTP to the MCP server and back

The model never knows it's calling an external service. It just sees tools.

## How It Works

On OpenClaw startup, the plugin uses `curl` (synchronous, required by OpenClaw's plugin lifecycle) to:

1. Send an MCP `initialize` handshake to each configured server
2. Send `tools/list` to discover available tools (with pagination support)
3. Capture the `Mcp-Session-Id` header for subsequent requests
4. Register each tool with a prefixed name (e.g. `freshrss_list_feeds`)

At call time, the plugin uses `fetch()` to POST `tools/call` to the server and parses the response (supports both plain JSON and SSE-wrapped responses).

## Configuration

In `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-mcp-bridge": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "name": "FreshRSS",
              "url": "http://127.0.0.1:3005",
              "prefix": "freshrss"
            },
            {
              "name": "cloudflare",
              "url": "https://mcp.cloudflare.com",
              "prefix": "cloudflare",
              "tokenFile": "/path/to/secrets/cloudflare-key"
            }
          ]
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
| `servers[].prefix` | string | Tool name prefix (e.g. `freshrss` -> `freshrss_list_feeds`) |
| `servers[].token` | string? | Bearer token for authentication |
| `servers[].tokenFile` | string? | Path to file containing Bearer token (alternative to inline token) |
| `servers[].path` | string? | MCP endpoint path (defaults to `/mcp`) |

The `tokenFile` field reads the token from a file at startup, so secrets don't need to be embedded in the config.

## Tool Naming

MCP servers expose tools with generic names (`search`, `list_feeds`). Multiple servers would collide. The bridge prefixes each tool:

| MCP Server | MCP Tool Name | OpenClaw Tool Name |
|------------|---------------|-------------------|
| FreshRSS | `list_feeds` | `freshrss_list_feeds` |
| FreshRSS | `get_unread_articles` | `freshrss_get_unread_articles` |
| Cloudflare | `search` | `cloudflare_search` |

## Installation

### From source

```bash
git clone https://github.com/ChrisLAS/openclaw-mcp-bridge.git
cd openclaw-mcp-bridge
npm install
npx tsc
```

### Install into OpenClaw

```bash
openclaw plugin install /path/to/openclaw-mcp-bridge
openclaw gateway restart
```

## Development

### Prerequisites

- Node.js >= 22
- An OpenClaw installation (v2026.2.x+)
- `curl` on the system PATH (used for synchronous discovery)

### Testing

```bash
npm install
npm test
```

## Project Structure

```
openclaw-mcp-bridge/
├── src/
│   ├── index.ts          # Plugin entry: register()
│   ├── discovery.ts      # tools/list via curl (sync), MCP handshake, pagination
│   ├── bridge.ts         # Tool wrapper: fetch() POST for tools/call
│   ├── config.ts         # Plugin config types, validation, tokenFile resolution
│   ├── sse.ts            # SSE response parser (handles both SSE and plain JSON)
│   └── util.ts           # URL sanitization for safe logging
├── tests/
│   ├── discovery.test.ts
│   ├── config.test.ts
│   └── sse.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## License

MIT
