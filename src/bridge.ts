import type { ServerConfig } from "./config.js";
import type { McpToolDefinition } from "./discovery.js";

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
 */
export function createBridgedTool(
  server: ServerConfig,
  mcpTool: McpToolDefinition,
): BridgedTool {
  const prefixedName = `${server.prefix}_${mcpTool.name}`;

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
      };
      if (server.token) {
        headers["Authorization"] = `Bearer ${server.token}`;
      }

      const response = await fetch(`${server.url}/mcp`, {
        method: "POST",
        headers,
        body,
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

      const result = await response.json();

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: true,
                message: result.error.message ?? JSON.stringify(result.error),
              }),
            },
          ],
        };
      }

      // MCP tools/call returns result.content (array of content blocks)
      // or result.result for some implementations
      const mcpContent = result.result?.content ?? result.result;
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
