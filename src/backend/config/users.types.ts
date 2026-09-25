/**
 * Frozen contract for task 16.1 — colleagues configuration.
 * Shape of users.json (deployment file): [{ "id": "mael", "name": "Maël" }]
 * Shape exposed by GET /users: { "items": [{ "id": "thomas", "display_name": "Thomas" }] }
 */

export interface ColleagueUser {
  /** Stable technical identifier. */
  id: string;
  /** Display name used in the drag & drop UI. */
  display_name: string;
}

export interface UsersConfig {
  items: ColleagueUser[];
}

export type UsersConfigErrorCode =
  | "USERS_CONFIG_MISSING"
  | "USERS_CONFIG_UNREADABLE"
  | "USERS_CONFIG_INVALID";

/** Explicit, loggable error raised when the users config file cannot be loaded. */
export class UsersConfigError extends Error {
  readonly code: UsersConfigErrorCode;
  /** Path of the file that failed to load. */
  readonly path: string;

  constructor(code: UsersConfigErrorCode, path: string, message: string) {
    super(message);
    this.name = "UsersConfigError";
    this.code = code;
    this.path = path;
  }
}

/** Raised when a transfer is requested towards a recipient absent from the configuration. */
export class UnknownRecipientError extends Error {
  readonly recipientUserId: string;

  constructor(recipientUserId: string) {
    super(
      `Recipient "${recipientUserId}" is not part of the allowed colleagues configuration.`,
    );
    this.name = "UnknownRecipientError";
    this.recipientUserId = recipientUserId;
  }
}