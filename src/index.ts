import { join } from "node:path";
import { homedir } from "node:os";
import { parseBridgeConfig } from "./config.js";
import { discoverToolsSync } from "./discovery.js";
import { createBridgedTool, type BridgedTool } from "./bridge.js";
import type { TokenResolutionOptions } from "./bridge.js";
import { sanitizeUrlForLog } from "./util.js";
import { TokenStore } from "./token-store.js";
import { parseTelegramUserId } from "./session.js";

/** Default path for the SQLite token database */
const DEFAULT_TOKEN_DB_PATH = join(homedir(), ".openclaw", "mcp-bridge-tokens.db");

/**
 * Context provided by OpenClaw to tool factories.
 * Mirrors OpenClawPluginToolContext from the OpenClaw source.
 */
type OpenClawPluginToolContext = {
  config?: Record<string, unknown>;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};

/**
 * A tool factory receives context about the current session
 * and returns a BridgedTool (or null to skip registration).
 */
type OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => BridgedTool | null;

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  registerTool: (tool: unknown) => void;
};

const plugin = {
  id: "openclaw-mcp-bridge",
  name: "MCP Bridge",
  description: "Bridges MCP HTTP servers as native OpenClaw agent tools",

  register(api: PluginApi) {
    const { config, warnings } = parseBridgeConfig(api.pluginConfig);

    // Surface any config parsing warnings so typos/invalid entries are visible
    for (const w of warnings) {
      api.logger.warn(`[mcp-bridge] Config warning: ${w}`);
    }

    if (config.servers.length === 0) {
      api.logger.warn("[mcp-bridge] No servers configured. Add servers to plugin config.");
      return;
    }

    // Initialize the token store (synchronous — safe in register())
    const dbPath = config.tokenDbPath ?? DEFAULT_TOKEN_DB_PATH;
    let tokenStore: TokenStore | undefined;
    try {
      tokenStore = new TokenStore(dbPath);
      api.logger.info(`[mcp-bridge] Token store initialized at ${dbPath}`);
    } catch (err) {
      api.logger.warn(
        `[mcp-bridge] Failed to initialize token store at ${dbPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Per-user tokens will be unavailable; falling back to config tokens only.`,
      );
    }

    let totalTools = 0;
    const registeredNames = new Set<string>();

    for (const server of config.servers) {
      // Log only the server name — avoid leaking tokens that may be in URL query params
      api.logger.info(
        `[mcp-bridge] Discovering tools from "${server.name}" (${sanitizeUrlForLog(server.url)})...`,
      );

      let discoveryResult;
      try {
        discoveryResult = discoverToolsSync(server);
      } catch (err) {
        api.logger.error(
          `[mcp-bridge] ${server.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const { tools: mcpTools, sessionId } = discoveryResult;

      api.logger.info(`[mcp-bridge] ${server.name}: found ${mcpTools.length} tools`);

      for (const mcpTool of mcpTools) {
        const prefixedName = `${server.prefix}_${mcpTool.name}`;

        // Warn on tool name collision (e.g. two servers with same prefix exposing same tool)
        if (registeredNames.has(prefixedName)) {
          api.logger.warn(
            `[mcp-bridge] Tool name collision: "${prefixedName}" is already registered. ` +
            `The duplicate from "${server.name}" will overwrite the previous registration.`,
          );
        }
        registeredNames.add(prefixedName);

        // Register a factory function. OpenClaw calls this once per agent session
        // with context about who is calling, letting us resolve per-user tokens.
        const factory: OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => {
          const userId = parseTelegramUserId(ctx.sessionKey);

          const tokenOpts: TokenResolutionOptions = {
            userId,
            tokenStore,
            service: server.prefix,
          };

          return createBridgedTool(server, mcpTool, sessionId, tokenOpts);
        };

        api.registerTool(factory);
        api.logger.info(`[mcp-bridge]   registered: ${prefixedName}`);
        totalTools++;
      }
    }

    api.logger.info(`[mcp-bridge] Total: ${totalTools} tools registered from ${config.servers.length} server(s)`);
  },
};

export default plugin;
