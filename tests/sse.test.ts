import { describe, it, expect } from "vitest";
import { parseSseResponse } from "../src/sse.js";

describe("parseSseResponse", () => {
  describe("plain JSON", () => {
    it("returns plain JSON as-is", () => {
      const json = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}';
      expect(parseSseResponse(json)).toBe(json);
    });

    it("handles plain JSON with whitespace", () => {
      const json = '  {"foo":"bar"}  ';
      expect(parseSseResponse(json)).toBe('{"foo":"bar"}');
    });

    it("handles empty object", () => {
      expect(parseSseResponse("{}")).toBe("{}");
    });
  });

  describe("single-event SSE", () => {
    it("parses simple single-event SSE", () => {
      const sse = `event: message
data: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`;
      expect(parseSseResponse(sse)).toBe(
        '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
      );
    });

    it("handles event:message without space", () => {
      const sse = `event:message
data: {"jsonrpc":"2.0","id":1,"result":{}}`;
      expect(parseSseResponse(sse)).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    });

    it("handles data without explicit event header", () => {
      const sse = `data: {"jsonrpc":"2.0","id":1}`;
      expect(parseSseResponse(sse)).toBe('{"jsonrpc":"2.0","id":1}');
    });

    it("handles multiline data within single event", () => {
      const sse = `event: message
data: {"line1": "value1"
data: "line2": "value2"
data: }`;
      expect(parseSseResponse(sse)).toBe(
        '{"line1": "value1"\n"line2": "value2"\n}'
      );
    });

    it("strips 'data:' prefix and whitespace", () => {
      const sse = `data:   {"key": "value"}`;
      expect(parseSseResponse(sse)).toBe('{"key": "value"}');
    });
  });

  describe("multi-event SSE", () => {
    it("returns data from the last message event", () => {
      const sse = `event: message
data: {"first": "event"}

event: message
data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}`;
      expect(parseSseResponse(sse)).toBe(
        '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'
      );
    });

    it("handles mixed event types and takes last message", () => {
      const sse = `event: custom
data: {"ignore":"this"}
event: message
data: {"keep":"this"}`;
      expect(parseSseResponse(sse)).toBe('{"keep":"this"}');
    });

    it("handles event with no data before message event", () => {
      const sse = `event: custom
data: ignored
event: message
data: {"final": true}`;
      expect(parseSseResponse(sse)).toBe('{"final": true}');
    });
  });

  describe("malformed input", () => {
    it("returns empty string for empty input", () => {
      expect(parseSseResponse("")).toBe("");
    });

    it("returns whitespace-only trimmed to empty", () => {
      expect(parseSseResponse("   \n\t   ")).toBe("");
    });

    it("returns unrecognized content as-is", () => {
      const input = "not valid json or sse";
      expect(parseSseResponse(input)).toBe(input);
    });

    it("handles lines that look like SSE but have no data", () => {
      const sse = `event: message
no-data-here: foo
another: bar`;
      expect(parseSseResponse(sse)).toBe(sse);
    });

    it("handles malformed data lines (no colon)", () => {
      const sse = `data
data: valid`;
      expect(parseSseResponse(sse)).toBe("valid");
    });
  });

  describe("edge cases", () => {
    it("handles CRLF line endings", () => {
      const sse = "event: message\r\ndata: {\"test\": true}";
      expect(parseSseResponse(sse)).toBe('{"test": true}');
    });

    it("handles data line with only whitespace after prefix", () => {
      const sse = "data:   \ndata: {}";
      // First data line becomes empty string after trim, second becomes {}
      // Joined together gives "\n{}"
      expect(parseSseResponse(sse)).toBe("\n{}");
    });

    it("handles comment lines (starting with colon)", () => {
      const sse = `: this is a comment
data: {"valid": true}`;
      expect(parseSseResponse(sse)).toBe('{"valid": true}');
    });
  });
});
