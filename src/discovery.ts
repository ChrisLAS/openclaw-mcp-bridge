import { execFileSync } from "node:child_process";
import { DEFAULT_MCP_PATH, type ServerConfig } from "./config.js";
import { parseSseResponse } from "./sse.js";
import { sanitizeUrlForLog } from "./util.js";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type DiscoveryResult = {
  tools: McpToolDefinition[];
  /** MCP session ID captured from the server, if provided */
  sessionId?: string;
};

/**
 * Verify that curl is available on the system.
 * Throws a descriptive error if it is not found.
 */
let curlChecked = false;
function assertCurlAvailable(): void {
  if (curlChecked) return;
  try {
    execFileSync("curl", ["--version"], { encoding: "utf-8", timeout: 5_000 });
    curlChecked = true;
  } catch {
    throw new Error(
      "curl is not available on this system. " +
      "The MCP bridge requires curl for synchronous HTTP requests during discovery " +
      "(OpenClaw's register() API is synchronous). " +
      "Please install curl and ensure it is on the PATH.",
    );
  }
}

/**
 * Execute a synchronous curl POST and return { body, headers }.
 * Uses -i to include response headers in the output so we can capture Mcp-Session-Id.
 */
function curlPost(
  url: string,
  headers: string[],
  body: string,
  sessionId?: string,
): { body: string; headers: string } {
  // -i includes response headers in the output
  const args = ["-s", "-i", "--max-time", "10", "-X", "POST", url];
  for (const h of headers) {
    args.push("-H", h);
  }
  if (sessionId) {
    args.push("-H", `Mcp-Session-Id: ${sessionId}`);
  }
  args.push("-d", body);

  const raw = execFileSync("curl", args, {
    encoding: "utf-8",
    timeout: 15_000,
  });

  // Split headers from body. HTTP headers end at the first blank line (\r\n\r\n).
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    // No clear header/body split — treat entire output as body
    return { body: raw, headers: "" };
  }
  return {
    headers: raw.slice(0, headerEnd),
    body: raw.slice(headerEnd + 4),
  };
}

/**
 * Extract Mcp-Session-Id from raw response headers.
 */
function extractSessionId(rawHeaders: string): string | undefined {
  for (const line of rawHeaders.split("\r\n")) {
    const lower = line.toLowerCase();
    if (lower.startsWith("mcp-session-id:")) {
      return line.slice("mcp-session-id:".length).trim();
    }
  }
  return undefined;
}

/**
 * Synchronously discover tools from an MCP HTTP server via JSON-RPC.
 *
 * Uses curl via execFileSync because OpenClaw's plugin register() must be
 * synchronous — Node's built-in fetch is async-only. This is a deliberate
 * trade-off to work within OpenClaw's plugin lifecycle.
 *
 * Steps:
 * 1. Send an MCP `initialize` handshake
 * 2. Send `tools/list`, paginating if the server returns a `nextCursor`
 * 3. Capture `Mcp-Session-Id` from response headers for later use
 */
export function discoverToolsSync(server: ServerConfig): DiscoveryResult {
  // Preflight: ensure curl is available
  assertCurlAvailable();

  const endpoint = `${server.url}${server.path ?? DEFAULT_MCP_PATH}`;
  const safeUrl = sanitizeUrlForLog(endpoint);

  const baseHeaders = [
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
  ];
  if (server.token) {
    baseHeaders.push(`Authorization: Bearer ${server.token}`);
  }

  let sessionId: string | undefined;

  try {
    // --- Step 1: MCP initialize handshake ---
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "openclaw-mcp-bridge",
          version: "0.1.0",
        },
      },
      id: "init-1",
    });

    const initResp = curlPost(endpoint, baseHeaders, initBody);
    sessionId = extractSessionId(initResp.headers);

    // We don't strictly need the initialize result, but we parse it to check
    // for errors. If the server doesn't support initialize, we continue anyway.
    try {
      const initJson = JSON.parse(parseSseResponse(initResp.body));
      if (initJson.error) {
        // Some servers may not require initialize — log but continue
      }
    } catch {
      // initialize response couldn't be parsed — continue to tools/list
    }

    // Send notifications/initialized (required by MCP spec after initialize)
    const initializedBody = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    try {
      curlPost(endpoint, baseHeaders, initializedBody, sessionId);
    } catch {
      // Best-effort — some servers don't require this notification
    }

    // --- Step 2: tools/list with pagination ---
    const allTools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    let requestId = 1;

    do {
      const listParams: Record<string, unknown> = {};
      if (cursor) {
        listParams.cursor = cursor;
      }

      const listBody = JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/list",
        params: listParams,
        id: requestId++,
      });

      const listResp = curlPost(endpoint, baseHeaders, listBody, sessionId);

      // Capture session ID from any response (server may set it on any response)
      const respSessionId = extractSessionId(listResp.headers);
      if (respSessionId) {
        sessionId = respSessionId;
      }

      const jsonStr = parseSseResponse(listResp.body);
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

      allTools.push(...(tools as McpToolDefinition[]));
      cursor = response.result?.nextCursor;
    } while (cursor);

    return { tools: allTools, sessionId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to discover tools from ${server.name} (${safeUrl}): ${msg}`);
  }
}
