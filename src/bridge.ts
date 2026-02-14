import { DEFAULT_MCP_PATH, type ServerConfig } from "./config.js";
import type { McpToolDefinition } from "./discovery.js";
import { parseSseResponse } from "./sse.js";
import type { TokenStore } from "./token-store.js";

/** Timeout for tools/call requests (30 seconds) */
const EXECUTE_TIMEOUT_MS = 30_000;

// Minimal AgentTool shape matching @mariozechner/pi-agent-core.
// We use a structural type to avoid importing the full openclaw dependency.
export type BridgedTool = {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

/**
 * Options for token resolution at execute() time.
 */
export type TokenResolutionOptions = {
  /** Telegram user ID parsed from the session key, if available */
  userId?: string;
  /** Token store for per-user token lookup */
  tokenStore?: TokenStore;
  /** Service name (server prefix) used as the key in the token store */
  service: string;
};

/**
 * Resolve the bearer token to use for a tool call.
 *
 * Priority:
 * 1. Per-user token from the token store (if userId + store are available)
 * 2. Hardcoded token from server config (Phase A backwards compat)
 * 3. undefined (no token available)
 *
 * Returns { token, error } where error is set if a user-specific token
 * was expected but not found or expired.
 */
function resolveToken(
  server: ServerConfig,
  opts: TokenResolutionOptions,
): { token: string | undefined; error: string | undefined } {
  // Try per-user token first
  if (opts.userId && opts.tokenStore) {
    const record = opts.tokenStore.getToken(opts.userId, opts.service);
    if (record) {
      if (opts.tokenStore.isExpired(record)) {
        return {
          token: undefined,
          error:
            `Your ${opts.service} token has expired. ` +
            `Please run /connect ${opts.service} to re-authenticate.`,
        };
      }
      return { token: record.access_token, error: undefined };
    }
  }

  // Fall back to hardcoded server config token (Phase A compat)
  if (server.token) {
    return { token: server.token, error: undefined };
  }

  // No token available anywhere
  if (opts.userId && opts.tokenStore) {
    // We have the infrastructure but no token stored — prompt the user
    return {
      token: undefined,
      error:
        `No ${opts.service} token found for your account. ` +
        `Please run /connect ${opts.service} to authenticate.`,
    };
  }

  // No token store, no config token — proceed without auth (server may not need it)
  return { token: undefined, error: undefined };
}

/**
 * Create an OpenClaw-compatible tool that bridges calls to an MCP server.
 *
 * Tool name is prefixed: e.g. prefix="notion", mcpTool.name="search" -> "notion_search"
 *
 * @param server   Server configuration
 * @param mcpTool  Tool definition from discovery
 * @param sessionId  Optional MCP session ID captured during discovery
 * @param tokenOpts  Optional token resolution options for per-user tokens
 */
export function createBridgedTool(
  server: ServerConfig,
  mcpTool: McpToolDefinition,
  sessionId?: string,
  tokenOpts?: TokenResolutionOptions,
): BridgedTool {
  const prefixedName = `${server.prefix}_${mcpTool.name}`;
  const endpoint = `${server.url}${server.path ?? DEFAULT_MCP_PATH}`;

  return {
    name: prefixedName,
    label: `${server.name}: ${mcpTool.name}`,
    description: mcpTool.description ?? `Call ${mcpTool.name} on ${server.name} MCP server`,
    parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
    async execute(toolCallId, params) {
      // Resolve token at execute() time (not at factory time) so that
      // tokens added/refreshed between tool calls are picked up
      const { token, error } = tokenOpts
        ? resolveToken(server, tokenOpts)
        : { token: server.token, error: undefined };

      if (error) {
        return {
          content: [{ type: "text", text: error }],
        };
      }

      const body = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: mcpTool.name,
          arguments: params,
        },
        id: toolCallId,
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      if (sessionId) {
        headers["Mcp-Session-Id"] = sessionId;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                status: response.status,
                message: text.slice(0, 1000),
              }),
            },
          ],
        };
      }

      // Response may be SSE format (event: message\ndata: {...}) or plain JSON.
      // Wrap parsing in try/catch — the server may return malformed body,
      // HTML error pages, or truncated SSE even with a 200 status.
      let result: Record<string, unknown>;
      try {
        const rawText = await response.text();
        const jsonStr = parseSseResponse(rawText);
        result = JSON.parse(jsonStr);
      } catch (parseErr) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: `Failed to parse MCP response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
              }),
            },
          ],
        };
      }

      if (result.error) {
        const errObj = result.error as Record<string, unknown>;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: errObj.message ?? JSON.stringify(errObj),
              }),
            },
          ],
        };
      }

      // MCP tools/call returns result.content (array of content blocks)
      // or result.result for some implementations.
      // Guard against result.result being undefined (missing entirely).
      const resultObj = result.result as Record<string, unknown> | undefined;
      const mcpContent = resultObj?.content ?? resultObj ?? null;

      if (mcpContent === null || mcpContent === undefined) {
        return {
          content: [{ type: "text", text: "(no content returned)" }],
        };
      }

      const payload =
        typeof mcpContent === "string"
          ? mcpContent
          : JSON.stringify(mcpContent, null, 2);

      return {
        content: [{ type: "text", text: payload }],
        details: mcpContent,
      };
    },
  };
}
