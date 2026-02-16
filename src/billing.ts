/**
 * Billing API client for pal-e-billing service.
 *
 * Queries per-user subscription status to enforce tier-based
 * access to MCP services (Notion, LinkedIn, Gmail, Calendar).
 */

/** Response shape from GET /status/{telegram_user_id} */
export type BillingStatus = {
  is_active: boolean;
  status: string;
  tier: string;
  email: string | null;
  gcal_gmail_status: string | null;
};

/** Result wrapper that distinguishes "API down" from "user not found" */
export type BillingResult = {
  reachable: boolean;
  status?: BillingStatus;
};

/** Cached billing status with TTL */
type CachedStatus = {
  status: BillingStatus;
  fetchedAt: number;
};

/** How long to cache billing status (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Max cache entries to prevent unbounded growth */
const CACHE_MAX_SIZE = 1000;

/** Shorter TTL for negative (404) cache entries (1 minute) */
const NEGATIVE_CACHE_TTL_MS = 60 * 1000;

/** Timeout for billing API requests (5 seconds) */
const BILLING_TIMEOUT_MS = 5_000;

/** Sentinel status cached for 404 (user not found) responses */
const NOT_FOUND_STATUS: BillingStatus = {
  is_active: false,
  status: "not_found",
  tier: "none",
  email: null,
  gcal_gmail_status: null,
};

type BillingLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export class BillingClient {
  private cache = new Map<string, CachedStatus>();

  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
    private readonly logger: BillingLogger,
  ) {}

  /**
   * Get the billing status for a Telegram user.
   *
   * Returns a BillingResult with `reachable` flag so callers can
   * distinguish "API down" (fail-open) from "user not found" (block).
   */
  async getStatus(telegramUserId: string): Promise<BillingResult> {
    // Check cache first (delete if expired)
    const cached = this.cache.get(telegramUserId);
    if (cached) {
      const ttl = cached.status === NOT_FOUND_STATUS ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS;
      if (Date.now() - cached.fetchedAt < ttl) {
        return { reachable: true, status: cached.status };
      }
      this.cache.delete(telegramUserId);
    }

    try {
      const response = await fetch(`${this.apiUrl}/status/${telegramUserId}`, {
        method: "GET",
        headers: {
          "X-API-Key": this.apiKey,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      });

      if (!response.ok) {
        if (response.status === 404) {
          // User not found — cache with short TTL to avoid hammering API
          this.evictIfFull();
          this.cache.set(telegramUserId, { status: NOT_FOUND_STATUS, fetchedAt: Date.now() });
          return { reachable: true, status: NOT_FOUND_STATUS };
        }
        this.logger.warn(
          `[tier-gate] Billing API returned ${response.status} for user ${telegramUserId}`,
        );
        // Non-404 server error: treat as unreachable (fail-open)
        return { reachable: false };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        this.logger.warn(
          `[tier-gate] Billing API returned non-JSON response for user ${telegramUserId}`,
        );
        return { reachable: false };
      }

      // Validate required fields to avoid caching garbage
      const obj = body as Record<string, unknown>;
      if (typeof obj.is_active !== "boolean" || typeof obj.tier !== "string" || typeof obj.status !== "string") {
        this.logger.warn(
          `[tier-gate] Billing API returned malformed body for user ${telegramUserId}`,
        );
        return { reachable: false };
      }

      const status = obj as unknown as BillingStatus;
      this.evictIfFull();
      this.cache.set(telegramUserId, { status, fetchedAt: Date.now() });
      return { reachable: true, status };
    } catch (err) {
      this.logger.warn(
        `[tier-gate] Billing API unreachable: ${err instanceof Error ? err.message : String(err)}. Failing open.`,
      );
      return { reachable: false };
    }
  }

  /** Evict expired entries; if still full, drop oldest */
  private evictIfFull(): void {
    if (this.cache.size < CACHE_MAX_SIZE) return;

    const now = Date.now();
    for (const [key, entry] of this.cache) {
      const ttl = entry.status === NOT_FOUND_STATUS ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS;
      if (now - entry.fetchedAt >= ttl) {
        this.cache.delete(key);
      }
    }

    // Still full after expiry sweep — drop oldest entry (Map iterates in insertion order)
    if (this.cache.size >= CACHE_MAX_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  /** Invalidate the cache for a specific user */
  invalidate(telegramUserId: string): void {
    this.cache.delete(telegramUserId);
  }

  /** Clear the entire cache */
  clearCache(): void {
    this.cache.clear();
  }
}
