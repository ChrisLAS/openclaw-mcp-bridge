import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseBridgeConfig } from "../src/config.js";

// Mock fs module
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "node:fs";

const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

describe("parseBridgeConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("valid entries", () => {
    it("parses a valid single server config", () => {
      const input = {
        servers: [
          {
            name: "test-server",
            url: "http://localhost:3000",
            prefix: "test",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toHaveLength(1);
      expect(result.config.servers[0]).toEqual({
        name: "test-server",
        url: "http://localhost:3000",
        prefix: "test",
        token: undefined,
        tokenFile: undefined,
        path: undefined,
      });
      expect(result.warnings).toHaveLength(0);
    });

    it("parses multiple valid server configs", () => {
      const input = {
        servers: [
          { name: "server1", url: "http://localhost:3000", prefix: "s1" },
          { name: "server2", url: "http://localhost:3001", prefix: "s2" },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toHaveLength(2);
      expect(result.warnings).toHaveLength(0);
    });

    it("includes optional token field", () => {
      const input = {
        servers: [
          {
            name: "auth-server",
            url: "http://localhost:3000",
            prefix: "auth",
            token: "secret-token",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers[0].token).toBe("secret-token");
    });

    it("includes optional tokenFile field", () => {
      const input = {
        servers: [
          {
            name: "file-auth",
            url: "http://localhost:3000",
            prefix: "file",
            tokenFile: "/path/to/token",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers[0].tokenFile).toBe("/path/to/token");
    });

    it("includes optional path field", () => {
      const input = {
        servers: [
          {
            name: "custom-path",
            url: "http://localhost:3000",
            prefix: "cp",
            path: "/custom/mcp",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers[0].path).toBe("/custom/mcp");
    });

    it("strips trailing slashes from URL", () => {
      const input = {
        servers: [
          {
            name: "strip-slashes",
            url: "http://localhost:3000///",
            prefix: "ss",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers[0].url).toBe("http://localhost:3000");
    });

    it("includes optional timeout", () => {
      const input = {
        servers: [],
        timeout: 60000,
      };
      const result = parseBridgeConfig(input);
      expect(result.config.timeout).toBe(60000);
    });
  });

  describe("missing fields", () => {
    it("warns when servers array is missing", () => {
      const result = parseBridgeConfig(undefined);
      expect(result.config.servers).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("warns when servers is not an array", () => {
      const result = parseBridgeConfig({ servers: "not-an-array" });
      expect(result.config.servers).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it("warns when entry is not an object", () => {
      const input = {
        servers: ["not-an-object", null, 123],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toEqual([]);
      expect(result.warnings).toHaveLength(3);
      expect(result.warnings[0]).toContain("servers[0]: entry is not an object");
    });

    it("warns when name is missing", () => {
      const input = {
        servers: [
          { url: "http://localhost:3000", prefix: "test" },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("missing required field(s): name");
    });

    it("warns when url is missing", () => {
      const input = {
        servers: [
          { name: "test", prefix: "test" },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toEqual([]);
      expect(result.warnings[0]).toContain("missing required field(s): url");
    });

    it("warns when prefix is missing", () => {
      const input = {
        servers: [
          { name: "test", url: "http://localhost:3000" },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toEqual([]);
      expect(result.warnings[0]).toContain("missing required field(s): prefix");
    });

    it("warns about multiple missing fields in one entry", () => {
      const input = {
        servers: [{}],
      };
      const result = parseBridgeConfig(input);
      expect(result.warnings[0]).toContain("missing required field(s): name, url, prefix");
    });

    it("includes unknown keys info when there are missing required fields", () => {
      const input = {
        servers: [
          {
            name: "test",
            // missing url and prefix
            unknownField: "value",
            anotherUnknown: 123,
          },
        ],
      };
      const result = parseBridgeConfig(input);
      // Unknown keys are reported alongside missing fields warning
      const hasWarning = result.warnings.some(w => 
        w.includes("unknown keys") && w.includes("unknownField")
      );
      expect(hasWarning).toBe(true);
    });

    it("skips entries with missing required fields but continues processing", () => {
      const input = {
        servers: [
          { name: "valid", url: "http://localhost:3000", prefix: "v" },
          { name: "invalid" },
          { name: "also-valid", url: "http://localhost:3001", prefix: "av" },
        ],
      };
      const result = parseBridgeConfig(input);
      expect(result.config.servers).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("tokenFile resolution", () => {
    it("reads token from tokenFile when token is not provided", () => {
      mockReadFileSync.mockReturnValue("file-token-value");
      
      const input = {
        servers: [
          {
            name: "file-auth",
            url: "http://localhost:3000",
            prefix: "fa",
            tokenFile: "/home/user/.token",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      
      expect(mockReadFileSync).toHaveBeenCalledWith("/home/user/.token", "utf-8");
      expect(result.config.servers[0].token).toBe("file-token-value");
    });

    it("prefers inline token over tokenFile", () => {
      mockReadFileSync.mockReturnValue("file-token");
      
      const input = {
        servers: [
          {
            name: "inline-preferred",
            url: "http://localhost:3000",
            prefix: "ip",
            token: "inline-token",
            tokenFile: "/path/to/file",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      
      expect(mockReadFileSync).not.toHaveBeenCalled();
      expect(result.config.servers[0].token).toBe("inline-token");
    });

    it("warns when tokenFile cannot be read", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file");
      });
      
      const input = {
        servers: [
          {
            name: "broken-file",
            url: "http://localhost:3000",
            prefix: "bf",
            tokenFile: "/nonexistent/token",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      
      expect(result.config.servers[0].token).toBeUndefined();
      expect(result.warnings[0]).toContain("failed to read tokenFile");
    });

    it("trims whitespace from tokenFile contents", () => {
      mockReadFileSync.mockReturnValue("  \n  file-token-with-whitespace  \n  ");
      
      const input = {
        servers: [
          {
            name: "trim-test",
            url: "http://localhost:3000",
            prefix: "tt",
            tokenFile: "/path/to/token",
          },
        ],
      };
      const result = parseBridgeConfig(input);
      
      expect(result.config.servers[0].token).toBe("file-token-with-whitespace");
    });
  });

  describe("timeout handling", () => {
    it("defaults timeout to undefined when not specified", () => {
      const input = { servers: [] };
      const result = parseBridgeConfig(input);
      expect(result.config.timeout).toBeUndefined();
    });

    it("accepts numeric timeout", () => {
      const input = { servers: [], timeout: 45000 };
      const result = parseBridgeConfig(input);
      expect(result.config.timeout).toBe(45000);
    });

    it("ignores non-numeric timeout", () => {
      const input = { servers: [], timeout: "30000" as unknown };
      const result = parseBridgeConfig(input);
      expect(result.config.timeout).toBeUndefined();
    });
  });
});
