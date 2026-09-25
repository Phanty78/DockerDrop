/**
 * Task 16.3 — archives a Docker volume locally as a zstd-compressed tar (architecture §3).
 *
 * The volume is read through `docker run --rm -v <volume>:/volume:ro <helperImage> tar -C /volume
 * -cf - .` (an argv array, never a shell string, so a volume name cannot inject anything), then
 * piped through zstd into `outputPath + ".part"`. The part file is renamed to `outputPath` only
 * once every byte has been written: a partial archive is never exposed, and any failure removes it
 * while reporting an explicit `VolumeArchiveError`. The S3 upload belongs to a later task.
 */

import { createWriteStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";

import {
  DEFAULT_ARCHIVE_HELPER_IMAGE,
  VOLUME_NAME_PATTERN,
  VolumeArchiveError,
} from "./archive.types";
import type { CreateVolumeArchive, VolumeTarSource, VolumeTarStream } from "./archive.types";

/** Suffix of the in-progress archive; renamed to the final path only once complete. */
const PART_SUFFIX = ".part";

/**
 * Tar arguments reading the volume root: `-C /volume` selects the mount point and `.` keeps the
 * `./`-prefixed entry layout (`./README.txt`, `./data/…`).
 */
const TAR_ARGUMENTS = ["tar", "-C", "/volume", "-cf", "-", "."] as const;

/**
 * Default `VolumeTarSource`: streams a volume through the Docker CLI helper container.
 *
 * A missing named volume is NOT an error for `docker run -v <name>:/volume:ro`: Docker creates an
 * empty volume instead, which would silently produce an empty archive and leak the new volume on
 * the host. `docker volume inspect` therefore runs as a pre-flight check and an inaccessible volume
 * throws before any container is started.
 *
 * `close()` waits for the container to exit and drains stderr; a non-zero exit (unreadable volume,
 * tar failure, Docker daemon error) rejects with an explicit message carrying the exit code and the
 * trimmed stderr, so the failure is loggable as-is.
 */
export function createDockerCliTarSource(
  dockerBinary = "docker",
  helperImage = DEFAULT_ARCHIVE_HELPER_IMAGE,
): VolumeTarSource {
  return (volumeName: string): VolumeTarStream => {
    const inspection = Bun.spawnSync([dockerBinary, "volume", "inspect", volumeName]);

    if (inspection.exitCode !== 0) {
      const detail = inspection.stderr.toString().trim();
      throw new Error(
        `volume "${volumeName}" is not accessible: ${detail === "" ? `docker volume inspect exited with code ${inspection.exitCode}` : detail}`,
      );
    }

    const proc = Bun.spawn(
      [dockerBinary, "run", "--rm", "-v", `${volumeName}:/volume:ro`, helperImage, ...TAR_ARGUMENTS],
      { stdout: "pipe", stderr: "pipe" },
    );

    return {
      bytes: proc.stdout,
      async close(): Promise<void> {
        const exitCode = await proc.exited;
        const stderr = (await new Response(proc.stderr).text()).trim();

        if (exitCode !== 0) {
          throw new Error(
            `docker run ${helperImage} tar on volume "${volumeName}" failed with exit code ${exitCode}` +
              (stderr === "" ? "" : `: ${stderr}`),
          );
        }
      },
    };
  };
}

/** Human-readable failure detail; filesystem errors keep their `code` (ENOENT, ENOSPC…) for logs. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const { code } = error as NodeJS.ErrnoException;
    const prefixed = typeof code === "string" && code !== "" && !error.message.startsWith(code);
    return prefixed ? `${code}: ${error.message}` : error.message;
  }

  return String(error);
}

/**
 * Removes the part file and closes the tar stream, best effort: cleanup must never mask the failure
 * being reported, so `close()` and `unlink()` errors are swallowed (a missing part file, when the
 * destination could not even be opened, is expected). The caller rethrows afterwards.
 */
async function discardPartialArchive(
  partPath: string,
  tarStream: VolumeTarStream | null,
): Promise<void> {
  if (tarStream !== null) {
    try {
      await tarStream.close();
    } catch {
      // The tar failure is already reported; a second close() error adds no information.
    }
  }

  try {
    await unlink(partPath);
  } catch {
    // Nothing to remove, or the part file cannot be removed: the root failure stays the report.
  }
}

/**
 * Maps a stream failure to its contract code: a filesystem error naming the part file is a write
 * failure, anything else (broken tar stream, unreadable volume) a tar failure.
 *
 * The classification reads the error itself rather than the stage that reported it: opening,
 * writing or closing the part file yields a node:fs error carrying that file's `path`, while errors
 * surfaced by the tar source describe the volume and cannot. This stays exact even though a stream
 * pipeline destroys every stage with the same error object.
 */
function toArchiveFailure(
  error: unknown,
  partPath: string,
  volumeName: string,
): VolumeArchiveError {
  if (error instanceof VolumeArchiveError) {
    return error;
  }

  const fsError = error as NodeJS.ErrnoException | null;
  const isPartFileFailure =
    typeof fsError === "object" &&
    fsError !== null &&
    fsError.path === partPath &&
    typeof fsError.code === "string" &&
    fsError.code !== "";

  if (isPartFileFailure) {
    return new VolumeArchiveError(
      "ARCHIVE_WRITE_FAILED",
      `Writing archive part file "${partPath}" failed: ${describeFailure(error)}`,
    );
  }

  return new VolumeArchiveError(
    "VOLUME_TAR_FAILED",
    `Reading volume "${volumeName}" through the tar source failed: ${describeFailure(error)}`,
  );
}

/**
 * Streams `tarSource(volumeName)` through zstd into `outputPath + ".part"`, then renames the part
 * file to `outputPath` and returns its path and size. An empty volume yields a valid empty-tar
 * archive, not an error.
 *
 * Every failure removes the part file and throws a `VolumeArchiveError`: `VOLUME_NAME_INVALID`
 * (blank or malformed name), `VOLUME_TAR_FAILED` (source creation failure, non-zero `close()`,
 * broken stream) or `ARCHIVE_WRITE_FAILED` (part file not writable, not renamable). A partial
 * archive is never left at `outputPath`.
 */
export const createVolumeArchive: CreateVolumeArchive = async (options, deps) => {
  const volumeName = options.volumeName.trim();

  if (volumeName === "" || !VOLUME_NAME_PATTERN.test(volumeName)) {
    throw new VolumeArchiveError(
      "VOLUME_NAME_INVALID",
      `Docker volume name ${JSON.stringify(options.volumeName)} is invalid: expected a value` +
        ` matching ${VOLUME_NAME_PATTERN} after trimming`,
    );
  }

  const { outputPath } = options;
  const partPath = `${outputPath}${PART_SUFFIX}`;
  const tarSource = deps?.tarSource ?? createDockerCliTarSource();

  let tarStream: VolumeTarStream;
  try {
    tarStream = tarSource(volumeName);
  } catch (error) {
    throw new VolumeArchiveError(
      "VOLUME_TAR_FAILED",
      `Starting the tar source for volume "${volumeName}" failed: ${describeFailure(error)}`,
    );
  }

  try {
    await pipeline(
      Readable.fromWeb(tarStream.bytes as unknown as NodeWebReadableStream<Uint8Array>),
      createZstdCompress(),
      createWriteStream(partPath),
    );
  } catch (error) {
    await discardPartialArchive(partPath, tarStream);
    throw toArchiveFailure(error, partPath, volumeName);
  }

  try {
    await tarStream.close();
  } catch (error) {
    await discardPartialArchive(partPath, tarStream);
    throw new VolumeArchiveError(
      "VOLUME_TAR_FAILED",
      `Reading volume "${volumeName}" through the tar source failed: ${describeFailure(error)}`,
    );
  }

  try {
    await rename(partPath, outputPath);
  } catch (error) {
    await discardPartialArchive(partPath, null);
    throw new VolumeArchiveError(
      "ARCHIVE_WRITE_FAILED",
      `Writing archive "${outputPath}" failed: ${describeFailure(error)}`,
    );
  }

  let archiveSize: number;
  try {
    ({ size: archiveSize } = await stat(outputPath));
  } catch (error) {
    throw new VolumeArchiveError(
      "ARCHIVE_WRITE_FAILED",
      `Reading the size of archive "${outputPath}" failed: ${describeFailure(error)}`,
    );
  }

  return { archivePath: outputPath, archiveSize };
};
