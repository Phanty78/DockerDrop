/**
 * Frozen contract for task 16.7 — direct archive upload from the source agent
 * (architecture §6 steps 3–5, §9.3, §9.4, §16.7).
 *
 * The agent drives a transfer through three ports, none of which ever routes
 * the archive through the backend:
 * - `SourceTransferClient`: backend API port (POST /transfers, then the PATCH
 *   status changes of §9.4); an HTTP implementation lives in ./client.ts and
 *   tests fake it.
 * - `UploadArchiveToS3`: direct PUT of the finished archive to the temporary
 *   presigned URL (`storage.upload` of §9.3); implementation in ./upload.ts.
 * - `RunSourceTransfer`: orchestrates §6 steps 3–5 — create the transfer, report
 *   `preparing` while the archive is being built, report `uploading` while it
 *   goes up to S3, confirm with `ready` + `archive_size` only after a successful
 *   upload, and report `failed` on any error. Implementation in ./source-transfer.ts.
 *
 * No resume mechanism: a manual relaunch simply runs a fresh transfer
 * (§16.7 bullet 5). Errors are explicit and loggable: class + `code` + message.
 */

import type { VolumeTarSource } from "../docker/archive.types";

/** Statuses the source agent may drive a transfer through (subset of the §8 lifecycle). */
export type SourceTransferStatus = "preparing" | "uploading" | "ready" | "failed";

export type SourceTransferErrorCode =
  /** POST /transfers was refused by the backend or the transport failed. */
  | "TRANSFER_CREATE_FAILED"
  /** A PATCH /transfers/{id} status change was refused or the transport failed. */
  | "TRANSFER_STATUS_UPDATE_FAILED"
  /** The PUT to the presigned URL failed at the transport level (network, invalid URL). */
  | "S3_UPLOAD_REQUEST_FAILED"
  /** S3 answered the PUT with a non-2xx status (403 SignatureDoesNotMatch, 410 expired…). */
  | "S3_UPLOAD_REJECTED";

/** Explicit, loggable error raised when a source-side transfer step is refused or fails. */
export class SourceTransferError extends Error {
  readonly code: SourceTransferErrorCode;

  constructor(code: SourceTransferErrorCode, message: string) {
    super(message);
    this.name = "SourceTransferError";
    this.code = code;
  }
}

/** POST /transfers 201 mapped to what the agent needs; `uploadUrl` is `storage.upload`. */
export interface CreatedTransferDescriptor {
  readonly id: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
}

/** What the agent asks the backend for when initiating a transfer. */
export interface CreateTransferRequest {
  readonly recipientUserId: string;
  readonly volumeName: string;
}

/**
 * Backend port of the source agent (§6 step 3 and step 5). `createTransfer`
 * initiates the temporary transfer; `updateStatus` applies one §9.4 status
 * change, passing `archiveSize` when (and only when) confirming `ready`.
 * Implementations must throw SourceTransferError, never a bare fetch error.
 */
export interface SourceTransferClient {
  createTransfer(request: CreateTransferRequest): Promise<CreatedTransferDescriptor>;
  updateStatus(transferId: string, status: SourceTransferStatus, archiveSize?: number): Promise<void>;
}

/** Extra deps of the direct S3 PUT; both injectable so tests stay deterministic. */
export interface UploadArchiveDeps {
  /** HTTP transport; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Called with cumulative uploaded bytes on every chunk; the last call is (total, total). */
  readonly onProgress?: (bytesUploaded: number, totalBytes: number) => void;
}

export interface UploadResult {
  /** Total bytes S3 accepted (the archive size on disk). */
  readonly uploadedBytes: number;
}

/**
 * Uploads the finished archive at `archivePath` straight to the temporary
 * presigned `uploadUrl` (§6 step 4): the binary goes to S3 only, never through
 * the backend. Streams the file (no full read into memory), reports chunk-level
 * progress through `deps.onProgress`, and throws SourceTransferError on any
 * transport failure (`S3_UPLOAD_REQUEST_FAILED`) or non-2xx answer
 * (`S3_UPLOAD_REJECTED`). Never reports a false success.
 */
export type UploadArchiveToS3 = (
  archivePath: string,
  uploadUrl: string,
  deps?: UploadArchiveDeps,
) => Promise<UploadResult>;

/** Progression remontée pendant la préparation et l'upload (§16.7 bullet 2). */
export type SourceTransferProgress =
  (event: {
    /** Phase being entered or advancing; byte fields only exist while uploading. */
    readonly phase: "preparing" | "uploading";
    readonly bytesUploaded?: number;
    readonly totalBytes?: number;
  }) => void;

/** What a transfer run is asked to send and where the archive must be written. */
export interface RunSourceTransferRequest {
  readonly volumeName: string;
  readonly recipientUserId: string;
  readonly outputPath: string;
}

export interface RunSourceTransferDeps {
  /** Backend port; faked in tests, HTTP implementation in production. */
  readonly client: SourceTransferClient;
  /** Direct S3 PUT; defaults to the real presigned-URL uploader (./upload.ts). */
  readonly upload?: UploadArchiveToS3;
  /** Tar producer of the archive step; defaults to the Docker CLI source (task 16.3). */
  readonly tarSource?: VolumeTarSource;
  /** Progression callback, fired while the phases run, never after the run settles. */
  readonly onProgress?: SourceTransferProgress;
}

export interface SourceTransferResult {
  readonly transferId: string;
  readonly archivePath: string;
  readonly archiveSize: number;
  readonly uploadedBytes: number;
}

/**
 * Orchestrates §6 steps 3–5 for one transfer, in order:
 * 1. `client.createTransfer` — the backend mints the id and the temporary
 *    presigned upload URL.
 * 2. Report `preparing` (status change + `onProgress`), build the archive with
 *    `createVolumeArchive` (task 16.3).
 * 3. Report `uploading`, PUT the archive straight to S3 through `deps.upload`
 *    (real one by default).
 * 4. Only after a successful upload: confirm `ready` to the backend with the
 *    exact `archive_size` — never before.
 * On any failure (archive or upload), the transfer is reported `failed`
 * (best effort) and the original error is rethrown as an explicit,
 * loggable error: no false success, no ready notification. A relaunch simply
 * calls `runSourceTransfer` again with a fresh request — no resume state.
 */
export type RunSourceTransfer = (
  request: RunSourceTransferRequest,
  deps: RunSourceTransferDeps,
) => Promise<SourceTransferResult>;