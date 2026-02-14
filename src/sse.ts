/**
 * Parse an SSE (Server-Sent Events) response body to extract JSON data.
 *
 * MCP Streamable HTTP servers may return responses as SSE format:
 *   event: message
 *   data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * This function extracts the JSON from the first "data:" line,
 * or returns the raw string if it's already plain JSON.
 */
export function parseSseResponse(raw: string): string {
  const trimmed = raw.trim();

  // If it starts with '{', it's already plain JSON
  if (trimmed.startsWith("{")) {
    return trimmed;
  }

  // Parse SSE format: look for "data: " lines
  for (const line of trimmed.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("data:")) {
      return stripped.slice(5).trim();
    }
  }

  // Fallback: return as-is and let JSON.parse handle the error
  return trimmed;
}
