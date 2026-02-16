/**
 * Tier-based service gating hooks for OpenClaw.
 *
 * Enforces per-user subscription tiers by querying the pal-e-billing API:
 * - before_agent_start: injects tier-appropriate service context into the system prompt
 * - before_tool_call: blocks gated tool calls (sessions_spawn to gated agents + direct gmail/gcal tool calls)
 */

import { BillingClient, type BillingStatus } from "./billing.js";
import { parseTelegramUserId } from "./session.js";

/** Billing upgrade URL shown to users */
const BILLING_URL = "https://ldraney.github.io/pal-e/billing";

/** Agent names that require Pro tier (for sessions_spawn gating) */
const GATED_AGENTS = new Set(["gmail-agent", "gcal-agent"]);

/** Tool name prefixes that require Pro tier (for direct tool call gating) */
const GATED_TOOL_PREFIXES = ["gmail_", "gcal_"];

type TierGateLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/** Hook context provided by OpenClaw */
type AgentHookContext = {
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  messageProvider?: string;
};

type BeforeAgentStartEvent = {
  prompt: string;
  messages?: unknown[];
};

type BeforeAgentStartResult = {
  systemPrompt?: string;
  prependContext?: string;
};

type ToolHookContext = {
  agentId?: string;
  sessionKey?: string;
  toolName: string;
};

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
};

type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
};

/**
 * Build the prependContext string based on a user's billing status.
 *
 * This is injected into the system prompt so the LLM knows which
 * services are available for the current user.
 */
function buildServiceContext(status: BillingStatus | undefined, failOpen: boolean): string {
  // Billing API unreachable — fail open, don't restrict services
  if (failOpen) {
    return (
      "Your available services for this user: Notion, LinkedIn, Gmail, and Calendar. " +
      "All services are available (billing status could not be verified)."
    );
  }

  // Unknown user or inactive subscription: treat as base tier
  if (!status || !status.is_active || status.tier === "base") {
    return (
      "Your available services for this user: Notion and LinkedIn only. " +
      "Do NOT offer or mention Gmail or Calendar. " +
      "If the user asks about Gmail or Calendar, explain that these require the Pro subscription."
    );
  }

  // Pro tier
  if (status.tier === "pro") {
    if (status.gcal_gmail_status === "active") {
      return (
        "Your available services for this user: Notion, LinkedIn, Gmail, and Calendar. " +
        "All services are active and ready to use."
      );
    }

    if (status.gcal_gmail_status === "pending") {
      return (
        "Your available services for this user: Notion and LinkedIn. " +
        "Gmail and Calendar are being activated (within 24 hours). " +
        "If the user asks about Gmail or Calendar, let them know activation is in progress."
      );
    }

    // Pro tier but gcal_gmail_status is something else (null, error, etc.)
    return (
      "Your available services for this user: Notion and LinkedIn. " +
      "Gmail and Calendar setup may be incomplete. " +
      "If the user asks about Gmail or Calendar, suggest they contact support."
    );
  }

  // Unknown tier: treat as base
  return (
    "Your available services for this user: Notion and LinkedIn only. " +
    "Do NOT offer or mention Gmail or Calendar."
  );
}

/**
 * Create tier-gating hook handlers.
 *
 * Returns the two hook handler functions to be registered with api.on().
 */
export function createTierGateHooks(billing: BillingClient, logger: TierGateLogger) {
  /**
   * before_agent_start hook.
   *
   * Looks up the user's subscription tier and injects service availability
   * context into the system prompt via prependContext.
   */
  async function beforeAgentStart(
    _event: BeforeAgentStartEvent,
    ctx: AgentHookContext,
  ): Promise<BeforeAgentStartResult | void> {
    const userId = parseTelegramUserId(ctx.sessionKey);
    if (!userId) {
      // Not a Telegram DM — skip tier gating (allow everything)
      return;
    }

    const result = await billing.getStatus(userId);

    if (!result.reachable) {
      logger.warn(`[tier-gate] Billing API unreachable, failing open for user ${userId}`);
      // Fail open: give full access context so the LLM doesn't restrict services
      return { prependContext: buildServiceContext(undefined, true) };
    }

    const context = buildServiceContext(result.status, false);

    logger.info(
      `[tier-gate] User ${userId}: tier=${result.status?.tier ?? "unknown"}, ` +
      `gcal_gmail=${result.status?.gcal_gmail_status ?? "n/a"}`,
    );

    return { prependContext: context };
  }

  /**
   * before_tool_call hook.
   *
   * Blocks gated tool calls for base-tier users. Catches both:
   * - sessions_spawn calls targeting gated agents (gmail-agent, gcal-agent)
   * - Direct tool calls with gated prefixes (gmail_*, gcal_*)
   */
  async function beforeToolCall(
    event: BeforeToolCallEvent,
    ctx: ToolHookContext,
  ): Promise<BeforeToolCallResult | void> {
    // Determine if this is a gated call
    let gatedLabel: string | undefined;

    if (event.toolName === "sessions_spawn") {
      const targetAgent = extractTargetAgent(event.params);
      if (targetAgent && GATED_AGENTS.has(targetAgent)) {
        gatedLabel = targetAgent;
      }
    } else if (GATED_TOOL_PREFIXES.some((p) => event.toolName.startsWith(p))) {
      gatedLabel = event.toolName;
    }

    if (!gatedLabel) {
      // Not a gated tool — allow through
      return;
    }

    const userId = parseTelegramUserId(ctx.sessionKey);
    if (!userId) {
      // Not a Telegram DM — allow through
      return;
    }

    const result = await billing.getStatus(userId);

    // Billing API unreachable — fail open, don't block tool calls
    if (!result.reachable) {
      logger.warn(
        `[tier-gate] Billing API unreachable, failing open for ${gatedLabel} (user ${userId})`,
      );
      return;
    }

    const status = result.status;

    // No status or inactive: block
    if (!status || !status.is_active || status.tier === "base") {
      logger.info(
        `[tier-gate] Blocked ${gatedLabel} for user ${userId} (tier: ${status?.tier ?? "none"})`,
      );
      return {
        block: true,
        blockReason:
          `Gmail and Calendar require the Pro subscription ($50/mo). ` +
          `Upgrade at ${BILLING_URL}`,
      };
    }

    // Pro tier but not active
    if (status.tier === "pro" && status.gcal_gmail_status !== "active") {
      logger.info(
        `[tier-gate] Blocked ${gatedLabel} for user ${userId} (gcal_gmail_status: ${status.gcal_gmail_status})`,
      );
      return {
        block: true,
        blockReason:
          "Gmail and Calendar are being activated. " +
          "You'll receive a confirmation within 24 hours.",
      };
    }

    // Pro tier with active gcal_gmail: allow through
  }

  return { beforeAgentStart, beforeToolCall };
}

/**
 * Extract the target agent name from sessions_spawn params.
 *
 * The params shape depends on OpenClaw's sessions_spawn tool definition.
 * Common patterns: { agent: "gmail-agent" } or { agentId: "gmail-agent" }
 */
function extractTargetAgent(params: Record<string, unknown>): string | undefined {
  if (typeof params.agent === "string") {
    return params.agent;
  }
  if (typeof params.agentId === "string") {
    return params.agentId;
  }
  // Some implementations use "name"
  if (typeof params.name === "string") {
    return params.name;
  }
  return undefined;
}

/** Exported for testing */
export const __testing = {
  buildServiceContext,
  extractTargetAgent,
  GATED_AGENTS,
  GATED_TOOL_PREFIXES,
  BILLING_URL,
};
