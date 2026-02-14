/**
 * Parse the Telegram user ID from OpenClaw's session key.
 *
 * Expected format: agent:main:telegram:default:direct:{telegram_user_id}
 *
 * Returns undefined for group chats, non-telegram channels, or malformed keys.
 */
export function parseTelegramUserId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) {
    return undefined;
  }

  const segments = sessionKey.split(":");
  if (segments.length < 6) {
    return undefined;
  }

  // Segment[2] must be "telegram" and segment[4] must be "direct"
  if (segments[2] !== "telegram" || segments[4] !== "direct") {
    return undefined;
  }

  const userId = segments[5];
  if (!userId) {
    return undefined;
  }

  return userId;
}
