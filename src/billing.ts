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

/** Timeout for billing API requests (5 seconds) */
const BILLING_TIMEOUT_MS = 5_000;

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
    // Check cache first
    const cached = this.cache.get(telegramUserId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { reachable: true, status: cached.status };
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
          // User not found — API is reachable, user just has no subscription
          return { reachable: true };
        }
        this.logger.warn(
          `[tier-gate] Billing API returned ${response.status} for user ${telegramUserId}`,
        );
        // Non-404 server error: treat as unreachable (fail-open)
        return { reachable: false };
      }

      const status = (await response.json()) as BillingStatus;
      this.cache.set(telegramUserId, { status, fetchedAt: Date.now() });
      return { reachable: true, status };
    } catch (err) {
      this.logger.warn(
        `[tier-gate] Billing API unreachable: ${err instanceof Error ? err.message : String(err)}. Failing open.`,
      );
      return { reachable: false };
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
