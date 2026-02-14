import { parseBridgeConfig } from "./config.js";
import { discoverToolsSync } from "./discovery.js";
import { createBridgedTool } from "./bridge.js";
import { sanitizeUrlForLog } from "./util.js";

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
        const bridged = createBridgedTool(server, mcpTool, sessionId);

        // Warn on tool name collision (e.g. two servers with same prefix exposing same tool)
        if (registeredNames.has(bridged.name)) {
          api.logger.warn(
            `[mcp-bridge] Tool name collision: "${bridged.name}" is already registered. ` +
            `The duplicate from "${server.name}" will overwrite the previous registration.`,
          );
        }
        registeredNames.add(bridged.name);

        api.registerTool(bridged);
        api.logger.info(`[mcp-bridge]   registered: ${bridged.name}`);
        totalTools++;
      }
    }

    api.logger.info(`[mcp-bridge] Total: ${totalTools} tools registered from ${config.servers.length} server(s)`);
  },
};

export default plugin;
