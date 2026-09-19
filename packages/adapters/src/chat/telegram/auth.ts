/**
 * Telegram user authorization utilities
 * Parses and validates user IDs for whitelist-based access control
 */

/**
 * Parse comma-separated user IDs from environment variable.
 * Returns an empty array when unset or unparseable — which this fork treats as
 * "no one is allowed", not "everyone is" (see `isUserAuthorized`).
 */
export function parseAllowedUserIds(envValue: string | undefined): number[] {
  if (!envValue || envValue.trim() === '') {
    return [];
  }

  return envValue
    .split(',')
    .map(id => id.trim())
    .filter(id => id !== '')
    .map(id => parseInt(id, 10))
    .filter(id => !isNaN(id) && id > 0);
}

/**
 * Check if a user ID is authorized.
 *
 * Upstream reads an empty whitelist as open access. This fork does the
 * opposite: the bot drives an agent with write access to a real checkout, so an
 * empty list authorizes nobody. `TelegramAdapter.start()` refuses to launch in
 * that state — this is the second line of defence, in case an adapter is ever
 * constructed and used without going through `start()`.
 */
export function isUserAuthorized(userId: number | undefined, allowedIds: number[]): boolean {
  // No whitelist configured — deny everyone rather than open the bot.
  if (allowedIds.length === 0) {
    return false;
  }

  // No user ID available (should not happen in normal Telegram flow)
  if (userId === undefined) {
    return false;
  }

  return allowedIds.includes(userId);
}
