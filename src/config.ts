export type ServerConfig = {
  /** Human-readable server name */
  name: string;
  /** Base URL of the MCP HTTP server (e.g. "http://localhost:8000") */
  url: string;
  /** Prefix for tool names (e.g. "notion" -> "notion_search") */
  prefix: string;
  /** Bearer token for authentication (Phase A: manual, Phase B: per-user OAuth) */
  token?: string;
};

export type BridgeConfig = {
  servers: ServerConfig[];
};

export function parseBridgeConfig(raw: Record<string, unknown> | undefined): BridgeConfig {
  if (!raw || !Array.isArray(raw.servers)) {
    return { servers: [] };
  }
  const servers: ServerConfig[] = [];
  for (const entry of raw.servers) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).name === "string" &&
      typeof (entry as Record<string, unknown>).url === "string" &&
      typeof (entry as Record<string, unknown>).prefix === "string"
    ) {
      const s = entry as Record<string, unknown>;
      servers.push({
        name: s.name as string,
        url: (s.url as string).replace(/\/+$/, ""), // strip trailing slashes
        prefix: s.prefix as string,
        token: typeof s.token === "string" ? s.token : undefined,
      });
    }
  }
  return { servers };
}
