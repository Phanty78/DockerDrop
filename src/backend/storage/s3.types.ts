/**
 * S3 storage contract (§3, §9.3, task 16.5).
 *
 * The backend never relays archive binaries: the source agent uploads directly
 * to S3 using a temporary, single-object mechanism minted per transfer. The
 * server-side S3 configuration stays in this process; nothing here may ever
 * serialize a permanent credential to a client (§9.3, §16.5).
 *
 * Concrete implementation: src/backend/storage/s3.ts
 * - `loadS3Config(env: Record<string, string | undefined>): S3PresignConfig`
 *   — throws S3ConfigError (S3_CONFIG_INCOMPLETE, listing every missing
 *   variable) when any of S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
 *   S3_SECRET_ACCESS_KEY is absent or blank.
 * - `createSigV4UploadMechanism(config: S3PresignConfig, now?: () => Date): S3UploadMechanism`
 *   — AWS SigV4 query-presigned PUT descriptor (X-Amz-* query parameters,
 *   UNSIGNED-PAYLOAD, HMAC-SHA256 via node:crypto); `now` is injectable for
 *   deterministic tests. The internal NWB s3-node module can be swapped in
 *   later behind this same port without touching the transfer contract.
 */

/** Frozen S3 key layout (§3): docker-volume-transfers/{transferId}/volume.tar.zst. */
export const S3_KEY_PREFIX = "docker-volume-transfers";

/** Archive object name inside each transfer prefix (§3). */
export const ARCHIVE_OBJECT_NAME = "volume.tar.zst";

/**
 * Deterministic object key of a transfer archive.
 * Derived from the transferId only — never from the real volume name — so
 * renames, special characters and cross-machine volume-name collisions cannot
 * affect storage addressing (§3). Pure: same transferId → same key.
 */
export function volumeArchiveKey(transferId: string): string {
  return `${S3_KEY_PREFIX}/${transferId}/${ARCHIVE_OBJECT_NAME}`;
}

/** Server-side S3 configuration; `secretAccessKey` never leaves this process. */
export interface S3PresignConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type S3ConfigErrorCode = "S3_CONFIG_INCOMPLETE";

/** Explicit, loggable S3 configuration error raised at boot. */
export class S3ConfigError extends Error {
  readonly code: S3ConfigErrorCode;
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Missing S3 configuration variable(s): ${missing.join(", ")}`);
    this.name = "S3ConfigError";
    this.code = "S3_CONFIG_INCOMPLETE";
    this.missing = missing;
  }
}

/**
 * Port minting the wire value of `storage.upload` for one transfer (§9.3).
 * The returned descriptor MUST be: temporary (valid at most until the
 * transfer's `expires_at`), scoped to the single object
 * `volumeArchiveKey(transferId)`, and free of any permanent S3 credential.
 */
export interface S3UploadMechanism {
  presignUpload(transferId: string, expiresAt: Date): string;
}
