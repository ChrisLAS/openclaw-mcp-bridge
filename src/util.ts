/**
 * Sanitize a URL for safe logging by stripping query parameters,
 * which may contain tokens or other secrets.
 */
export function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // If the URL can't be parsed, return a placeholder
    return "(invalid URL)";
  }
}
