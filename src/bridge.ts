import { DEFAULT_MCP_PATH, type ServerConfig } from "./config.js";
import type { McpToolDefinition } from "./discovery.js";
import { parseSseResponse } from "./sse.js";

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
 * Create an OpenClaw-compatible tool that bridges calls to an MCP server.
 *
 * Tool name is prefixed: e.g. prefix="notion", mcpTool.name="search" -> "notion_search"
 *
 * @param server   Server configuration
 * @param mcpTool  Tool definition from discovery
 * @param sessionId  Optional MCP session ID captured during discovery
 */
export function createBridgedTool(
  server: ServerConfig,
  mcpTool: McpToolDefinition,
  sessionId?: string,
): BridgedTool {
  const prefixedName = `${server.prefix}_${mcpTool.name}`;
  const endpoint = `${server.url}${server.path ?? DEFAULT_MCP_PATH}`;

  return {
    name: prefixedName,
    label: `${server.name}: ${mcpTool.name}`,
    description: mcpTool.description ?? `Call ${mcpTool.name} on ${server.name} MCP server`,
    parameters: mcpTool.inputSchema ?? { type: "object", properties: {} },
    async execute(toolCallId, params) {
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
      if (server.token) {
        headers["Authorization"] = `Bearer ${server.token}`;
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
