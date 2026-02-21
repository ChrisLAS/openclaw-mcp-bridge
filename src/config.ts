import { readFileSync } from "node:fs";

/** Default MCP endpoint path */
export const DEFAULT_MCP_PATH = "/mcp";

export type ServerConfig = {
  /** Human-readable server name */
  name: string;
  /** Base URL of the MCP HTTP server (e.g. "http://localhost:8000") */
  url: string;
  /** Prefix for tool names (e.g. "notion" -> "notion_search") */
  prefix: string;
  /** Bearer token for authentication */
  token?: string;
  /** Path to file containing Bearer token (alternative to inline token) */
  tokenFile?: string;
  /** MCP endpoint path (defaults to "/mcp") */
  path?: string;
};

export type BridgeConfig = {
  servers: ServerConfig[];
  /** HTTP request timeout in ms (default: 30000) */
  timeout?: number;
};

export type ParseResult = {
  config: BridgeConfig;
  /** Warnings about invalid or skipped server entries */
  warnings: string[];
};

export function parseBridgeConfig(raw: Record<string, unknown> | undefined): ParseResult {
  if (!raw || !Array.isArray(raw.servers)) {
    return { config: { servers: [] }, warnings: [] };
  }
  const servers: ServerConfig[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < raw.servers.length; i++) {
    const entry = raw.servers[i];
    if (typeof entry !== "object" || entry === null) {
      warnings.push(`servers[${i}]: entry is not an object, skipping`);
      continue;
    }
    const s = entry as Record<string, unknown>;
    const missing: string[] = [];
    if (typeof s.name !== "string") missing.push("name");
    if (typeof s.url !== "string") missing.push("url");
    if (typeof s.prefix !== "string") missing.push("prefix");

    if (missing.length > 0) {
      const label = typeof s.name === "string" ? s.name : `servers[${i}]`;
      const extra = Object.keys(s).filter((k) => !["name", "url", "prefix", "token", "tokenFile", "path"].includes(k));
      let msg = `${label}: missing required field(s): ${missing.join(", ")}`;
      if (extra.length > 0) {
        msg += ` (unknown keys: ${extra.join(", ")})`;
      }
      warnings.push(msg);
      continue;
    }

    const serverConfig: ServerConfig = {
      name: s.name as string,
      url: (s.url as string).replace(/\/+$/, ""), // strip trailing slashes
      prefix: s.prefix as string,
      token: typeof s.token === "string" ? s.token : undefined,
      tokenFile: typeof s.tokenFile === "string" ? s.tokenFile : undefined,
      path: typeof s.path === "string" ? s.path : undefined,
    };

    // Resolve token from tokenFile if token is not provided
    if (!serverConfig.token && serverConfig.tokenFile) {
      try {
        serverConfig.token = readFileSync(serverConfig.tokenFile, "utf-8").trim();
      } catch (err) {
        warnings.push(`${serverConfig.name}: failed to read tokenFile "${serverConfig.tokenFile}": ${err instanceof Error ? err.message : String(err)}`);
        serverConfig.token = undefined;
      }
    }

    servers.push(serverConfig);
  }

  const timeout = typeof raw.timeout === "number" ? raw.timeout : undefined;

  return { config: { servers, timeout }, warnings };
}
