/**
 * Frozen contract for task 16.4 — temporary transfer creation (architecture §9.3, §16.4).
 *
 * POST /transfers { "recipient_user_id": "thomas", "source_volume_name": "mysql_client_x" }
 *   → 201 { "id": "tr_…", "status": "created", "storage": { "upload": "…" }, "expires_at": "<ISO-8601>" }
 *
 * The transfer state is temporary and in-memory only: the MVP imposes no user,
 * machine or transfer persistent table (§8, §16.4). Since task 16.5,
 * `storage.upload` is the temporary S3 upload mechanism minted per transfer
 * by the injectable `S3UploadMechanism` port (src/backend/storage/s3.types.ts).
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
}

export type TransferErrorCode =
  | "TRANSFER_BODY_INVALID"
  | "TRANSFER_RECIPIENT_UNKNOWN";

/** Explicit, loggable error raised when a transfer creation is refused. */
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
}
