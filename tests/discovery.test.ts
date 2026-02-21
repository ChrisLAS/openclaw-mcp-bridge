import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { ServerConfig } from "../src/config.js";

// Mock child_process BEFORE importing discovery
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((cmd: string, args: string[], options?: object) => {
    // Handle curl --version check
    if (args && args[0] === "--version") {
      return "curl 7.88.1";
    }
    // Default response for any other curl call - will be overridden by test mocks
    return "HTTP/1.1 200 OK\r\n\r\n{}";
  }),
}));

// Import after mocking
const { discoverToolsSync } = await import("../src/discovery.js");

import { execFileSync } from "node:child_process";

const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>;

describe("discoverToolsSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createMockServer = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
    name: "test-mcp",
    url: "http://localhost:3000",
    prefix: "test",
    ...overrides,
  });

  const mockCurlResponse = (
    body: string,
    sessionId?: string
  ) => {
    let headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n";
    if (sessionId) {
      headers += `Mcp-Session-Id: ${sessionId}\r\n`;
    }
    headers += "\r\n";
    return headers + body;
  };

  describe("successful tool discovery", () => {
    it("discovers tools from MCP server", () => {
      // Override mocks for this specific test
      mockExecFileSync.mockReset();
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        // Determine which call this is based on the request body
        // We can't easily tell without parsing, so we return based on call order
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"test_tool"}]}}');
      });

      const result = discoverToolsSync(createMockServer());

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("test_tool");
    });

    it("uses custom MCP path when specified", () => {
      mockExecFileSync.mockReset();
      let capturedUrl = "";
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) {
          // URL is at index 6: ["-s", "-i", "--max-time", "10", "-X", "POST", url, ...]
          capturedUrl = args[6];
          return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        }
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      });

      discoverToolsSync(createMockServer({ path: "/custom/api" }));

      expect(capturedUrl).toBe("http://localhost:3000/custom/api");
    });

    it("includes Authorization header with token", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      });

      discoverToolsSync(createMockServer({ token: "secret-123" }));

      // Check all calls for Authorization header
      const allArgs = mockExecFileSync.mock.calls.flatMap(c => c[1] as string[]);
      expect(allArgs).toContain("Authorization: Bearer secret-123");
    });

    it("captures Mcp-Session-Id from response headers", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}', "session-abc-123");
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      });

      const result = discoverToolsSync(createMockServer());

      expect(result.sessionId).toBe("session-abc-123");
    });

    it("handles pagination with nextCursor", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        if (callCount === 3) return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"tool1"}],"nextCursor":"cursor-2"}}');
        return mockCurlResponse('{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"tool2"}]}}');
      });

      const result = discoverToolsSync(createMockServer());

      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("tool1");
      expect(result.tools[1].name).toBe("tool2");
    });

    it("sends Mcp-Session-Id in subsequent requests after receiving it", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        // Initialize returns session
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}', "session-xyz");
        // Notifications
        if (callCount === 2) return mockCurlResponse("{}");
        // Tools/list - should include session header
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
      });

      discoverToolsSync(createMockServer());

      // Check tools/list call for session header (3rd curl call)
      const toolsCall = mockExecFileSync.mock.calls[2];
      const args = toolsCall[1] as string[];
      expect(args).toContain("Mcp-Session-Id: session-xyz");
    });
  });

  describe("SSE handling", () => {
    it("parses JSON from SSE-wrapped response", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"sse_tool"}]}}');
      });

      const result = discoverToolsSync(createMockServer());

      expect(result.tools[0].name).toBe("sse_tool");
    });

    it("handles plain JSON response", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"json_tool"}]}}');
      });

      const result = discoverToolsSync(createMockServer());

      expect(result.tools[0].name).toBe("json_tool");
    });
  });

  describe("error handling", () => {
    it("throws error when curl is not available", () => {
      mockExecFileSync.mockReset();
      // Make --version check fail to trigger "curl not available" error
      // Note: The curlChecked flag may be cached from previous tests, so we need 
      // to simulate what happens when curl --version fails
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        // This simulates curl not being installed
        throw new Error("spawn curl ENOENT");
      });

      // This test verifies error handling - the exact message depends on whether
      // curl was previously cached. We check that some descriptive error is thrown.
      expect(() => discoverToolsSync(createMockServer())).toThrow(/curl|Failed to discover/);
    });

    it("throws error when tools/list returns JSON-RPC error", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Invalid Request"}}');
      });

      expect(() => discoverToolsSync(createMockServer())).toThrow("MCP error");
    });

    it("throws error when tools result is not an array", () => {
      mockExecFileSync.mockReset();
      
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        
        const callCount = mockExecFileSync.mock.calls.length;
        
        if (callCount === 1) return mockCurlResponse('{"jsonrpc":"2.0","id":"init-1","result":{}}');
        if (callCount === 2) return mockCurlResponse("{}");
        return mockCurlResponse('{"jsonrpc":"2.0","id":1,"result":{"tools":"not-an-array"}}');
      });

      expect(() => discoverToolsSync(createMockServer())).toThrow(
        "Unexpected tools/list response"
      );
    });

    it("throws descriptive error on discovery failure", () => {
      mockExecFileSync.mockReset();
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (args[0] === "--version") return "curl 7.88.1";
        throw new Error("Connection refused");
      });

      expect(() => discoverToolsSync(createMockServer())).toThrow(
        "Failed to discover tools from test-mcp"
      );
    });
  });
});
