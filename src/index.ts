import { parseBridgeConfig } from "./config.js";
import { discoverToolsSync } from "./discovery.js";
import { createBridgedTool } from "./bridge.js";

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
    const config = parseBridgeConfig(api.pluginConfig);

    if (config.servers.length === 0) {
      api.logger.warn("[mcp-bridge] No servers configured. Add servers to plugin config.");
      return;
    }

    let totalTools = 0;

    for (const server of config.servers) {
      api.logger.info(`[mcp-bridge] Discovering tools from ${server.name} (${server.url})...`);

      let mcpTools;
      try {
        mcpTools = discoverToolsSync(server);
      } catch (err) {
        api.logger.error(
          `[mcp-bridge] ${server.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      api.logger.info(`[mcp-bridge] ${server.name}: found ${mcpTools.length} tools`);

      for (const mcpTool of mcpTools) {
        const bridged = createBridgedTool(server, mcpTool);
        api.registerTool(bridged);
        api.logger.info(`[mcp-bridge]   registered: ${bridged.name}`);
        totalTools++;
      }
    }

    api.logger.info(`[mcp-bridge] Total: ${totalTools} tools registered from ${config.servers.length} server(s)`);
  },
};

export default plugin;
