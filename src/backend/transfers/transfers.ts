/**
 * Tasks 16.4 + 16.6 — temporary transfers: `POST /transfers` creation (architecture
 * §9.3, §16.4) and `PATCH /transfers/{transferId}` status changes through the
 * centralized §8 state machine (§9.4, §16.6).
 *
 * The transfer state is temporary and in-memory only (no user, machine or transfer
 * persistent table — §8). `storage.upload` is minted by the injected
 * `S3UploadMechanism` port (task 16.5): the backend never relays the archive
 * binary, the source agent uploads straight to S3 with that descriptor.
 *
 * Since task 16.6 every status change goes through `applyTransferStatus`, which
 * only accepts pairs allowed by `TRANSFER_TRANSITIONS` and fires the injected
 * `TransferReadyNotifier` port exactly once per valid transition to "ready"
 * (Google Chat lands behind it in task 16.8).
 */

import { ensureRecipientAllowed } from "../config/recipient";
import { UnknownRecipientError } from "../config/users.types";
import {
  DEFAULT_RETENTION_MS,
  TERMINAL_TRANSFER_STATUSES,
  TRANSFER_ID_PREFIX,
  TRANSFER_TRANSITIONS,
  TransferError,
} from "./transfers.types";
import type {
  ApplyTransferStatus,
  ApplyTransferStatusDeps,
  CreateTransfer,
  CreateTransferDeps,
  CreateTransferResponse,
  TransferRecord,
  TransferStatus,
  TransferStatusChangeResponse,
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

  /** Replaces the record of the same id; the §8 state machine commits through this. */
  update(record: TransferRecord): void {
    this.records.set(record.id, record);
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
 * Throws `TransferError("TRANSFER_BODY_INVALID")` naming the request, the field
 * and the reason, so every refusal is loggable as-is.
 */
function requireTrimmedString(
  body: Record<string, unknown>,
  field: string,
  requestLabel: string,
): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new TransferError(
      "TRANSFER_BODY_INVALID",
      `Invalid ${requestLabel} body: field "${field}" must be a string, received ${describeReceived(value)}.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TransferError(
      "TRANSFER_BODY_INVALID",
      `Invalid ${requestLabel} body: field "${field}" must not be blank, received ${JSON.stringify(value)}.`,
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
  const recipientUserId = requireTrimmedString(body, "recipient_user_id", "POST /transfers");
  const sourceVolumeName = requireTrimmedString(body, "source_volume_name", "POST /transfers");

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

/** True when `value` is one of the eight §8 statuses; membership derives from the frozen transition map. */
function isTransferStatus(value: string): value is TransferStatus {
  return Object.hasOwn(TRANSFER_TRANSITIONS, value);
}

/**
 * Validates a parsed PATCH /transfers/{transferId} body and applies the §8 state machine.
 * See `ApplyTransferStatus` in ./transfers.types for the frozen contract.
 */
export const applyTransferStatus: ApplyTransferStatus = (
  transferId: string,
  parsedBody: unknown,
  store: TransferStore,
  deps: ApplyTransferStatusDeps,
): TransferStatusChangeResponse => {
  const requestLabel = `PATCH /transfers/${transferId}`;

  if (
    typeof parsedBody !== "object" ||
    parsedBody === null ||
    Array.isArray(parsedBody)
  ) {
    throw new TransferError(
      "TRANSFER_BODY_INVALID",
      `Invalid ${requestLabel} body: expected a JSON object with "status", received ${describeReceived(parsedBody)}.`,
    );
  }

  const body = parsedBody as Record<string, unknown>;
  const status = requireTrimmedString(body, "status", requestLabel);
  if (!isTransferStatus(status)) {
    throw new TransferError(
      "TRANSFER_STATUS_UNKNOWN",
      `Unknown transfer status ${JSON.stringify(status)} for transfer "${transferId}": expected one of ${Object.keys(TRANSFER_TRANSITIONS).join(", ")}.`,
    );
  }

  const record = store.get(transferId);
  if (record === null) {
    throw new TransferError(
      "TRANSFER_NOT_FOUND",
      `Transfer "${transferId}" does not exist.`,
    );
  }

  if (TERMINAL_TRANSFER_STATUSES.includes(record.status)) {
    throw new TransferError(
      "TRANSFER_TRANSITION_INVALID",
      `Transfer "${transferId}" is in terminal status "${record.status}": no transition leaves a terminal status, received ${JSON.stringify(status)}.`,
    );
  }

  // An elapsed retention window may only be closed by "expired": anything else is
  // refused as expired, before the transition table is even consulted.
  const now = deps.now?.() ?? new Date();
  if (status !== "expired" && now.getTime() >= record.expiresAt.getTime()) {
    throw new TransferError(
      "TRANSFER_EXPIRED",
      `Transfer "${transferId}" expired at ${record.expiresAt.toISOString()}: only status "expired" is still accepted, received ${JSON.stringify(status)}.`,
    );
  }

  const allowed = TRANSFER_TRANSITIONS[record.status];
  if (!allowed.includes(status)) {
    throw new TransferError(
      "TRANSFER_TRANSITION_INVALID",
      `Invalid transition for transfer "${transferId}": "${record.status}" → ${JSON.stringify(status)} is not allowed by the §8 state machine (allowed from "${record.status}": ${allowed.join(", ")}).`,
    );
  }

  // `archive_size` is optional: absent, the record keeps the size it already knows;
  // present, it must be a non-negative integer number of bytes.
  let archiveSize = record.archiveSize;
  if (Object.hasOwn(body, "archive_size")) {
    const value = body["archive_size"];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      const received = typeof value === "number" ? String(value) : describeReceived(value);
      throw new TransferError(
        "TRANSFER_BODY_INVALID",
        `Invalid ${requestLabel} body: field "archive_size" must be a non-negative integer, received ${received}.`,
      );
    }
    archiveSize = value;
  }

  const updated: TransferRecord = {
    id: record.id,
    recipientUserId: record.recipientUserId,
    sourceVolumeName: record.sourceVolumeName,
    status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
  if (archiveSize !== undefined) {
    updated.archiveSize = archiveSize;
  }
  store.update(updated);

  // The ready-only port sees the committed record, once, after the commit (§16.6).
  // §8 isolation is enforced here, structurally: the record is already committed, so a
  // throwing notifier (the 16.8 Google Chat webhook) must never fail this PATCH nor turn
  // an already-ready transfer into an error — the failure is logged and left behind.
  if (status === "ready") {
    try {
      deps.notifier?.notifyReady(updated);
    } catch (error) {
      console.error(
        `[transfer-notifier] ready notification failed for transfer ${updated.id} (transfer stays ready, §8):`,
        error,
      );
    }
  }

  if (archiveSize === undefined) {
    return { id: updated.id, status, expires_at: updated.expiresAt.toISOString() };
  }
  return {
    id: updated.id,
    status,
    archive_size: archiveSize,
    expires_at: updated.expiresAt.toISOString(),
  };
};
