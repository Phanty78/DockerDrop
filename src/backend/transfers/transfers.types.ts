/**
 * Frozen contract for tasks 16.4–16.6 — temporary transfers (architecture §8, §9.3, §9.4).
 *
 * POST /transfers { "recipient_user_id": "thomas", "source_volume_name": "mysql_client_x" }
 *   → 201 { "id": "tr_…", "status": "created", "storage": { "upload": "…" }, "expires_at": "<ISO-8601>" }
 * PATCH /transfers/{transferId} { "status": "ready", "archive_size": 408021221 }
 *   → 200 { "id": "tr_…", "status": "ready", "archive_size": 408021221, "expires_at": "<ISO-8601>" }
 *
 * The transfer state is temporary and in-memory only: the MVP imposes no user,
 * machine or transfer persistent table (§8, §16.4). Since task 16.5,
 * `storage.upload` is the temporary S3 upload mechanism minted per transfer
 * by the injectable `S3UploadMechanism` port (src/backend/storage/s3.types.ts).
 * Since task 16.6, status changes go through the centralized state machine
 * `TRANSFER_TRANSITIONS` (§8): no caller can place a transfer in an
 * incoherent state, and only a valid transition to "ready" triggers the
 * injected `TransferReadyNotifier` port (Google Chat lands behind it in 16.8).
 */

import type { UsersConfig } from "../config/users.types";
import type { S3UploadMechanism } from "../storage/s3.types";

/** Transfer statuses of the §8 lifecycle; task 16.4 only ever produces "created". */
export type TransferStatus =
  | "created"
  | "preparing"
  | "uploading"
  | "ready"
  | "downloading"
  | "completed"
  | "failed"
  | "expired";

/** POST /transfers 201 response body; keys are frozen by §9.3 (no extra field). */
export interface CreateTransferResponse {
  id: string;
  status: TransferStatus;
  storage: { upload: string };
  expires_at: string;
}

/** Error response body for rejected transfers; explicit and loggable. */
export interface TransferErrorResponse {
  error: { code: TransferErrorCode; message: string };
}

/** In-memory state of a temporary transfer; created for diagnostics and later tasks, never persisted. */
export interface TransferRecord {
  id: string;
  recipientUserId: string;
  sourceVolumeName: string;
  status: TransferStatus;
  createdAt: Date;
  expiresAt: Date;
  /** Archive byte size, once reported by the source agent (§9.4 PATCH example); absent until known. */
  archiveSize?: number;
}

/**
 * Centralized §8 state machine: the only status changes a transfer may take.
 * Each non-terminal status allows its lifecycle successor plus "failed" (an
 * error can always abort a live transfer) and "expired" (a transfer whose
 * retention window elapsed). "completed", "failed" and "expired" are terminal.
 */
export const TRANSFER_TRANSITIONS: Readonly<Record<TransferStatus, readonly TransferStatus[]>> = {
  created: ["preparing", "failed", "expired"],
  preparing: ["uploading", "failed", "expired"],
  uploading: ["ready", "failed", "expired"],
  ready: ["downloading", "failed", "expired"],
  downloading: ["completed", "failed", "expired"],
  completed: [],
  failed: [],
  expired: [],
};

/**
 * Terminal statuses of the §8 lifecycle: no transition ever leaves them. Derived
 * from TRANSFER_TRANSITIONS (a terminal status is a row with no outgoing
 * transition) so the terminal list and the transition table cannot drift.
 */
export const TERMINAL_TRANSFER_STATUSES: readonly TransferStatus[] = (
  Object.keys(TRANSFER_TRANSITIONS) as readonly TransferStatus[]
).filter((status) => TRANSFER_TRANSITIONS[status].length === 0);

export type TransferErrorCode =
  | "TRANSFER_BODY_INVALID"
  | "TRANSFER_RECIPIENT_UNKNOWN"
  | "TRANSFER_NOT_FOUND"
  | "TRANSFER_STATUS_UNKNOWN"
  | "TRANSFER_TRANSITION_INVALID"
  | "TRANSFER_EXPIRED";

/** Explicit, loggable error raised when a transfer creation or status change is refused. */
export class TransferError extends Error {
  readonly code: TransferErrorCode;

  constructor(code: TransferErrorCode, message: string) {
    super(message);
    this.name = "TransferError";
    this.code = code;
  }
}

/** Prefix of temporary transfer ids ("tr_123" in §9.3). */
export const TRANSFER_ID_PREFIX = "tr_";

/** Default retention (24 h) used to compute `expires_at`; overridable via deps or deployment. */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Deps of `createTransfer`.
 * - `users`: colleagues configuration used to refuse an unknown recipient (task 16.1 helper).
 * - `storage`: port minting the temporary `storage.upload` descriptor for the
 *   transfer's single S3 object (task 16.5).
 * - `retentionMs`: retention duration; defaults to DEFAULT_RETENTION_MS.
 * - `now`: injectable clock so tests can freeze `expires_at` deterministically.
 */
export interface CreateTransferDeps {
  users: UsersConfig;
  storage: S3UploadMechanism;
  retentionMs?: number;
  now?: () => Date;
}

/**
 * Validates a parsed POST /transfers body and creates a temporary transfer.
 * - Body must be an object with non-blank string `recipient_user_id` and
 *   `source_volume_name`; both are trimmed and the trimmed values are used.
 * - The recipient must exist in the colleagues configuration (exact, case-sensitive id).
 * - `expires_at` = now + retention, ISO-8601.
 * - The record is stored in the given (in-memory) store; the 201 response shape is
 *   exactly CreateTransferResponse.
 * Throws TransferError("TRANSFER_BODY_INVALID") or TransferError("TRANSFER_RECIPIENT_UNKNOWN").
 */
export type CreateTransfer = (
  parsedBody: unknown,
  deps: CreateTransferDeps,
  store: TransferStore,
) => CreateTransferResponse;

/** In-memory temporary transfer state; deliberately the only state the backend keeps. */
export interface TransferStore {
  add(record: TransferRecord): void;
  get(id: string): TransferRecord | null;
  list(): readonly TransferRecord[];
  /** Replaces the record of the same id (the state machine commits this way). */
  update(record: TransferRecord): void;
}

/**
 * Port notified exactly once per valid transition to "ready" (§8, §16.6):
 * Google Chat lands behind it in task 16.8. Never called for "created",
 * "preparing", "uploading", invalid or refused transitions.
 * Implementations MUST never throw: a notification failure must never affect
 * the already-committed "ready" state (§8). The callsite guards defensively and
 * logs, so a throwing adapter cannot turn a committed PATCH into an error.
 */
export interface TransferReadyNotifier {
  notifyReady(record: TransferRecord): void;
}

/** Deps of `applyTransferStatus`: injectable clock and ready-only notifier port. */
export interface ApplyTransferStatusDeps {
  now?: () => Date;
  notifier?: TransferReadyNotifier;
}

/** PATCH /transfers/{transferId} 200 response body; `archive_size` appears once known. */
export interface TransferStatusChangeResponse {
  id: string;
  status: TransferStatus;
  archive_size?: number;
  expires_at: string;
}

/**
 * Validates a parsed PATCH /transfers/{transferId} body and applies the §8 state
 * machine (task 16.6, architecture §9.4).
 * - Body must be an object with a non-blank string `status` (trimmed) naming one
 *   of the eight statuses; anything else is refused.
 * - The transfer must exist and be non-terminal, and the current→target pair
 *   must be allowed by TRANSFER_TRANSITIONS; unknown ids, unknown statuses and
 *   incoherent transitions are refused with explicit codes.
 * - A transfer whose `expiresAt` has elapsed may only become "expired".
 * - `archive_size`, when present, must be a non-negative integer and is kept on
 *   the record (§9.4 example).
 * - The committed record replaces the previous one in the store; a valid
 *   transition to "ready" fires `deps.notifier` (if provided) with the
 *   committed record — never before, never for another status.
 * Throws TransferError with one of: TRANSFER_NOT_FOUND, TRANSFER_BODY_INVALID,
 * TRANSFER_STATUS_UNKNOWN, TRANSFER_TRANSITION_INVALID, TRANSFER_EXPIRED.
 */
export type ApplyTransferStatus = (
  transferId: string,
  parsedBody: unknown,
  store: TransferStore,
  deps: ApplyTransferStatusDeps,
) => TransferStatusChangeResponse;
