import { UnknownRecipientError } from "./users.types";
import type { ColleagueUser, UsersConfig } from "./users.types";

/**
 * Task 16.1 — allowed colleagues lookups (architecture §11).
 * Pure helpers over an in-memory `UsersConfig`, reused by `POST /transfers` (task 16.4)
 * to refuse a recipient absent from the colleagues configuration.
 * Ids are compared exactly: case-sensitive, no prefix match.
 */

/** Returns the configured colleague whose id equals `recipientUserId`, or `null`. */
export function findRecipient(
  config: UsersConfig,
  recipientUserId: string,
): ColleagueUser | null {
  return config.items.find((item) => item.id === recipientUserId) ?? null;
}

/** Returns the allowed colleague, or throws `UnknownRecipientError` when absent. */
export function ensureRecipientAllowed(
  config: UsersConfig,
  recipientUserId: string,
): ColleagueUser {
  const recipient = findRecipient(config, recipientUserId);
  if (recipient === null) {
    throw new UnknownRecipientError(recipientUserId);
  }
  return recipient;
}
