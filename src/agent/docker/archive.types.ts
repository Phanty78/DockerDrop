/**
 * Shared contract for volume archive creation (task 16.3).
 *
 * A volume archive is a zstd-compressed tar of the volume root contents
 * (`volume.tar.zst`, architecture doc §3), produced locally by the agent.
 * The S3 upload belongs to a later task and is out of scope here.
 */

/** Docker volume names: `[a-zA-Z0-9][a-zA-Z0-9_.-]*` (Engine naming rule). */
export const VOLUME_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** Helper image used to read a volume through the Docker CLI. */
export const DEFAULT_ARCHIVE_HELPER_IMAGE = "alpine:3";

/** Zstd frame magic bytes (0x28 0xB5 0x2F 0xFD), useful to validate archives. */
export const ZSTD_FRAME_MAGIC = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd);

export type VolumeArchiveErrorCode =
  /** The volume name is blank or does not match `VOLUME_NAME_PATTERN`. */
  | "VOLUME_NAME_INVALID"
  /** Reading the volume through Docker failed (missing volume, CLI error, broken stream). */
  | "VOLUME_TAR_FAILED"
  /** Writing the archive to `outputPath` failed. */
  | "ARCHIVE_WRITE_FAILED";

/** Explicit, loggable error thrown by `createVolumeArchive`. */
export class VolumeArchiveError extends Error {
  readonly code: VolumeArchiveErrorCode;

  constructor(code: VolumeArchiveErrorCode, message: string) {
    super(message);
    this.name = "VolumeArchiveError";
    this.code = code;
  }
}

/**
 * Uncompressed tar stream of a volume's root contents, plus a `close()` hook.
 * `close()` resolves once the underlying producer finished successfully and
 * rejects when it failed (non-zero exit, unreadable volume...). Once `close()`
 * has settled, no further `bytes` chunks may arrive.
 */
export interface VolumeTarStream {
  readonly bytes: ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

/** Produces the tar stream of a volume's contents. Injectable for tests. */
export type VolumeTarSource = (volumeName: string) => VolumeTarStream;

export interface VolumeArchiveOptions {
  /** Volume name, trimmed then validated against `VOLUME_NAME_PATTERN`. */
  readonly volumeName: string;
  /** Path of the archive to produce (absolute or cwd-relative). */
  readonly outputPath: string;
}

export interface VolumeArchiveDeps {
  /** Tar producer; defaults to the Docker CLI based source. */
  readonly tarSource?: VolumeTarSource;
}

export interface VolumeArchiveResult {
  /** Same as `options.outputPath`; a complete archive exists at this path. */
  readonly archivePath: string;
  /** Archive size in bytes. */
  readonly archiveSize: number;
}

/**
 * Streams `tarSource(volumeName)` through zstd into `outputPath + ".part"`,
 * then renames the partial file to `outputPath` on success. On any failure the
 * partial file is removed and a `VolumeArchiveError` is thrown: no partial
 * archive is ever left behind or reported as a success.
 */
export type CreateVolumeArchive = (
  options: VolumeArchiveOptions,
  deps?: VolumeArchiveDeps,
) => Promise<VolumeArchiveResult>;