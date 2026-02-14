import { execFileSync } from "node:child_process";
import type { ServerConfig } from "./config.js";
import { parseSseResponse } from "./sse.js";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/**
 * Synchronously discover tools from an MCP HTTP server via JSON-RPC tools/list.
 * Uses curl via execFileSync because OpenClaw's plugin register() must be synchronous.
 */
export function discoverToolsSync(server: ServerConfig): McpToolDefinition[] {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/list",
    id: 1,
  });

  const headers = [
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
  ];
  if (server.token) {
    headers.push(`Authorization: Bearer ${server.token}`);
  }

  const args = ["-s", "--max-time", "10", "-X", "POST", `${server.url}/mcp`];
  for (const h of headers) {
    args.push("-H", h);
  }
  args.push("-d", body);

  try {
    const raw = execFileSync("curl", args, {
      encoding: "utf-8",
      timeout: 15_000,
    });
    const jsonStr = parseSseResponse(raw);
    const response = JSON.parse(jsonStr);
    if (response.error) {
      throw new Error(
        `MCP error: ${response.error.message ?? JSON.stringify(response.error)}`,
      );
    }
    const tools = response.result?.tools;
    if (!Array.isArray(tools)) {
      throw new Error(`Unexpected tools/list response: ${jsonStr.slice(0, 200)}`);
    }
    return tools as McpToolDefinition[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to discover tools from ${server.name} (${server.url}): ${msg}`);
  }
}
