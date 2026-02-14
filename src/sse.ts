/**
 * Parse an SSE (Server-Sent Events) response body to extract JSON data.
 *
 * MCP Streamable HTTP servers may return responses as SSE format:
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * This function extracts JSON from the data lines belonging to the last
 * "event: message" block. Multi-line data payloads within the same event
 * are concatenated (per the SSE spec, joined with newlines).
 *
 * Limitation: For multi-event SSE streams (multiple "event: message" blocks),
 * only the data from the last event is returned. Supporting true streaming of
 * multiple events would require a callback-based or async-iterator API.
 *
 * If the response is already plain JSON, it is returned as-is.
 */
export function parseSseResponse(raw: string): string {
  const trimmed = raw.trim();

  // If it starts with '{', it's already plain JSON
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  const lines = trimmed.split("\n");

  // Collect data lines belonging to the last "event: message" block.
  // We track whether we're inside an "event: message" section and
  // reset collected data lines whenever we see a new "event: message" header.
  let dataLines: string[] = [];
  let inMessageEvent = false;

  for (const line of lines) {
    const stripped = line.trim();

    if (stripped === "event: message" || stripped === "event:message") {
      // Start of a new message event — reset collected data
      inMessageEvent = true;
      dataLines = [];
      continue;
    }

    // An empty line terminates the current event in SSE
    if (stripped === "") {
      // Don't clear inMessageEvent — we already captured the data lines
      continue;
    }

    if (stripped.startsWith("data:")) {
      // If we haven't seen an explicit "event: message" header, still collect
      // (some servers omit the event type, defaulting to "message")
      if (!inMessageEvent && dataLines.length === 0) {
        inMessageEvent = true;
      }
      if (inMessageEvent) {
        dataLines.push(stripped.slice(5).trim());
      }
    }
  }

  if (dataLines.length > 0) {
    return dataLines.join("\n");
  }

  // Fallback: return as-is and let JSON.parse handle the error
  return trimmed;
}
