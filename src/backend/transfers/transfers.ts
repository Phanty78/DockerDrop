/**
 * Task 16.4 — `POST /transfers`: creation of a temporary transfer (architecture §9.3, §16.4).
 *
 * The transfer state is temporary and in-memory only (no user, machine or transfer
 * persistent table — §8). `storage.upload` is minted by the injected
 * `S3UploadMechanism` port (task 16.5): the backend never relays the archive
 * binary, the source agent uploads straight to S3 with that descriptor.
 */

import { ensureRecipientAllowed } from "../config/recipient";
import { UnknownRecipientError } from "../config/users.types";
import {
  DEFAULT_RETENTION_MS,
  TRANSFER_ID_PREFIX,
  TransferError,
} from "./transfers.types";
import type {
  CreateTransfer,
  CreateTransferDeps,
  CreateTransferResponse,
  TransferRecord,
  TransferStore,
} from "./transfers.types";

/** Plain in-memory `TransferStore`; the only state a temporary transfer ever has (never persisted). */
export class InMemoryTransferStore implements TransferStore {
  private readonly records = new Map<string, TransferRecord>();

  add(record: TransferRecord): void {
    this.records.set(record.id, record);
  }

  get(id: string): TransferRecord | null {
    return this.records.get(id) ?? null;
  }

  list(): readonly TransferRecord[] {
    return [...this.records.values()];
  }
}

/** Human-readable description of a received value, used to make body errors loggable. */
function describeReceived(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `a string ${JSON.stringify(value)}`;
  return typeof value;
}

/**
 * Reads a non-blank, trimmed string field out of a parsed JSON object.
 * Throws `TransferError("TRANSFER_BODY_INVALID")` naming the field and the reason.
 */
function requireTrimmedString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new TransferError(
      "TRANSFER_BODY_INVALID",
      `Invalid POST /transfers body: field "${field}" must be a string, received ${describeReceived(value)}.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TransferError(
      "TRANSFER_BODY_INVALID",
      `Invalid POST /transfers body: field "${field}" must not be blank, received ${JSON.stringify(value)}.`,
    );
  }
  return trimmed;
}

/**
 * Validates a parsed POST /transfers body and creates a temporary transfer.
 * See `CreateTransfer` in ./transfers.types for the frozen contract.
 */
export const createTransfer: CreateTransfer = (
  parsedBody: unknown,
  deps: CreateTransferDeps,
  store: TransferStore,
): CreateTransferResponse => {
  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    Array.isArray(parsedBody)
  ) {
    throw new TransferError(
      "TRANSFER_BODY_INVALID",
      `Invalid POST /transfers body: expected a JSON object with "recipient_user_id" and "source_volume_name", received ${describeReceived(parsedBody)}.`,
    );
  }

  const body = parsedBody as Record<string, unknown>;
  const recipientUserId = requireTrimmedString(body, "recipient_user_id");
  const sourceVolumeName = requireTrimmedString(body, "source_volume_name");

  try {
    ensureRecipientAllowed(deps.users, recipientUserId);
  } catch (error) {
    if (error instanceof UnknownRecipientError) {
      throw new TransferError(
        "TRANSFER_RECIPIENT_UNKNOWN",
        `Recipient "${recipientUserId}" is not part of the allowed colleagues configuration.`,
      );
    }
    throw error;
  }

  const createdAt = deps.now?.() ?? new Date();
  const retentionMs = deps.retentionMs ?? DEFAULT_RETENTION_MS;
  const expiresAt = new Date(createdAt.getTime() + retentionMs);

  const id = `${TRANSFER_ID_PREFIX}${crypto.randomUUID()}`;
  // Minted before the record is stored: a mechanism failure must leave the store empty.
  // Anything it throws propagates untouched (the route answers 500 for non-TransferError).
  const upload = deps.storage.presignUpload(id, expiresAt);

  const record: TransferRecord = {
    id,
    recipientUserId,
    sourceVolumeName,
    status: "created",
    createdAt,
    expiresAt,
  };
  store.add(record);

  return {
    id: record.id,
    status: "created",
    storage: { upload },
    expires_at: expiresAt.toISOString(),
  };
};
