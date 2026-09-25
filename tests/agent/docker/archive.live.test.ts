import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { createVolumeArchive } from "../../../src/agent/docker/archive";
import {
  DEFAULT_ARCHIVE_HELPER_IMAGE,
  VolumeArchiveError,
  ZSTD_FRAME_MAGIC,
  type VolumeArchiveDeps,
  type VolumeArchiveErrorCode,
  type VolumeArchiveOptions,
  type VolumeTarSource,
} from "../../../src/agent/docker/archive.types";

/**
 * Live test of `createVolumeArchive` (task 16.3): a real Docker Engine and the real
 * Docker CLI export a throwaway volume with the default `createDockerCliTarSource`, and
 * the resulting archive is decoded back and compared byte for byte with the files of
 * `tests/fixtures/volume`.
 *
 * The Engine is a prerequisite, so the cases below are skipped — a visible skip, never a
 * silent pass — when `/var/run/docker.sock` is absent. `existsSync` follows symlinks, so a
 * symlink pointing at a dead socket (Docker Desktop stopped) also counts as unavailable.
 */
const dockerEngineAvailable = existsSync("/var/run/docker.sock");

/** Live Docker CLI calls (first `alpine:3` pull, image start, tar extraction) exceed 5 s. */
setDefaultTimeout(120_000);

/** Docker CLI binary used by both the setup and the production archive source. */
const DOCKER_BINARY = "docker";

/** `tests/fixtures/volume`, canonicalised so Docker Desktop can mount it on macOS. */
const FIXTURES_DIR = realpathSync(join(import.meta.dir, "..", "..", "fixtures", "volume"));

/** Files of the reference volume, relative to its root; their bytes must survive the round trip. */
const FIXTURE_FILES = ["README.txt", join("data", "config.json"), join("data", "notes.md")] as const;

/** Throwaway volumes created by this file; the tests remove them, `afterEach` is the safety net. */
const trackedVolumes = new Set<string>();

/** Throwaway directories created by this file, removed by `afterEach`. */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const volumeName of [...trackedVolumes]) {
    removeTestVolume(volumeName);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Synchronous Docker CLI result with both streams decoded for loggable failures. */
interface DockerCommandResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs the Docker CLI synchronously: the setup steps are short, and keeping them
 * synchronous makes every volume/container operation ordered and immediately observable.
 */
function runDocker(args: readonly string[]): DockerCommandResult {
  const result = Bun.spawnSync({
    cmd: [DOCKER_BINARY, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    success: result.success,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/** Runs the Docker CLI and fails the current test with a loggable message on a non-zero exit. */
function runDockerOrThrow(args: readonly string[]): string {
  const result = runDocker(args);

  if (!result.success) {
    throw new Error(
      `docker ${args.join(" ")} failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout;
}

/**
 * Creates a throwaway Engine volume named `dd-test-archive-<uuid>`. Every test removes it
 * in a `finally`; `afterEach` tracks it as a second safety net so no volume can leak.
 */
function createTestVolume(): string {
  const volumeName = `dd-test-archive-${crypto.randomUUID()}`;
  runDockerOrThrow(["volume", "create", volumeName]);
  trackedVolumes.add(volumeName);

  return volumeName;
}

/** Force-removes a volume; CLI/spawn failures are ignored so cleanup never throws. */
function removeTestVolume(volumeName: string): void {
  trackedVolumes.delete(volumeName);
  try {
    runDocker(["volume", "rm", "-f", volumeName]);
  } catch {
    // Spawn failure (docker CLI unspawnable): nothing created through Docker can leak.
  }
}

/**
 * Copies the shared fixture tree into `volumeName` through a throwaway container: the
 * volume is mounted at `/volume`, the fixture read-only at `/fixture`.
 */
function populateVolumeFromFixture(volumeName: string): void {
  runDockerOrThrow([
    "run",
    "--rm",
    "-v",
    `${volumeName}:/volume`,
    "-v",
    `${FIXTURES_DIR}:/fixture:ro`,
    DEFAULT_ARCHIVE_HELPER_IMAGE,
    "sh",
    "-c",
    "cp -R /fixture/. /volume/",
  ]);
}

/** Creates a throwaway directory; `afterEach` removes it even when an assertion fails. */
async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dockerdrop-volume-archive-"));
  temporaryDirectories.push(directory);

  return directory;
}

/**
 * Asserts that `createVolumeArchive(options, deps)` rejects with a `VolumeArchiveError`
 * carrying the expected code and a non-empty, loggable message.
 */
async function captureVolumeArchiveError(
  options: VolumeArchiveOptions,
  expectedCode: VolumeArchiveErrorCode,
  deps?: VolumeArchiveDeps,
): Promise<VolumeArchiveError> {
  let caught: unknown;
  try {
    await createVolumeArchive(options, deps);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(VolumeArchiveError);

  const error = caught as VolumeArchiveError;
  expect(error.code).toBe(expectedCode);
  expect(error.message.length).toBeGreaterThan(0);

  return error;
}

describe("createVolumeArchive", () => {
  it.skipIf(!dockerEngineAvailable)(
    "exporte un volume de référence contenant plusieurs fichiers",
    async () => {
      const volumeName = createTestVolume();
      try {
        populateVolumeFromFixture(volumeName);
        const directory = await createTemporaryDirectory();
        const archivePath = join(directory, "volume.tar.zst");

        const result = await createVolumeArchive({ volumeName, outputPath: archivePath });

        expect(result.archivePath).toBe(archivePath);
        expect(result.archiveSize).toBeGreaterThan(0);

        const archiveBytes = readFileSync(archivePath);
        expect(archiveBytes.length).toBe(result.archiveSize);
        expect([...archiveBytes.subarray(0, ZSTD_FRAME_MAGIC.length)]).toEqual([
          ...ZSTD_FRAME_MAGIC,
        ]);
        // A successful export leaves the archive and nothing else behind.
        expect(existsSync(`${archivePath}.part`)).toBe(false);
        expect(readdirSync(directory)).toEqual(["volume.tar.zst"]);
      } finally {
        removeTestVolume(volumeName);
      }
    },
  );

  it.skipIf(!dockerEngineAvailable)(
    "l'archive restitue le contenu exact du volume de référence",
    async () => {
      const volumeName = createTestVolume();
      try {
        populateVolumeFromFixture(volumeName);
        const directory = await createTemporaryDirectory();
        const archivePath = join(directory, "volume.tar.zst");

        await createVolumeArchive({ volumeName, outputPath: archivePath });

        const tarPath = join(directory, "volume.tar");
        writeFileSync(tarPath, zstdDecompressSync(readFileSync(archivePath)));

        const extractDirectory = join(directory, "extract");
        mkdirSync(extractDirectory);

        const extraction = Bun.spawnSync({
          cmd: ["tar", "-C", extractDirectory, "-xf", tarPath],
          stdout: "pipe",
          stderr: "pipe",
        });
        const extractionFailure = extraction.success
          ? ""
          : `tar -C ${extractDirectory} -xf ${tarPath} failed (exit ${extraction.exitCode}): ${extraction.stderr.toString().trim()}`;
        expect(extractionFailure).toBe("");

        for (const fixtureFile of FIXTURE_FILES) {
          expect(readFileSync(join(extractDirectory, fixtureFile))).toEqual(
            readFileSync(join(FIXTURES_DIR, fixtureFile)),
          );
        }

        // L'arbre extrait est exactement l'arbre fixture : rien de plus, rien de moins.
        expect(readdirSync(extractDirectory, { recursive: true }).sort()).toEqual(
          readdirSync(FIXTURES_DIR, { recursive: true }).sort(),
        );
      } finally {
        removeTestVolume(volumeName);
      }
    },
  );

  it.skipIf(!dockerEngineAvailable)(
    "un volume inexistant échoue proprement en VOLUME_TAR_FAILED",
    async () => {
      const volumeName = `dd-test-archive-does-not-exist-${crypto.randomUUID()}`;
      try {
        const directory = await createTemporaryDirectory();
        const archivePath = join(directory, "volume.tar.zst");

        await captureVolumeArchiveError(
          { volumeName, outputPath: archivePath },
          "VOLUME_TAR_FAILED",
        );

        // No archive, no partial file, no leftover of any name.
        expect(existsSync(archivePath)).toBe(false);
        expect(existsSync(`${archivePath}.part`)).toBe(false);
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        // The volume never existed; the empty directory asserted above proves nothing leaked.
        removeTestVolume(volumeName);
      }
    },
  );

  it.skipIf(!dockerEngineAvailable)(
    "un nom de volume invalide est rejeté avant tout appel Docker",
    async () => {
      let tarSourceCalls = 0;
      const tarSourceSpy: VolumeTarSource = () => {
        tarSourceCalls += 1;
        throw new Error("tarSource must not be reached for an invalid volume name");
      };

      const volumeName = "has space";
      try {
        const directory = await createTemporaryDirectory();
        const archivePath = join(directory, "volume.tar.zst");

        await captureVolumeArchiveError(
          { volumeName, outputPath: archivePath },
          "VOLUME_NAME_INVALID",
          { tarSource: tarSourceSpy },
        );

        // The injected source is the observation point: it is never reached, so no Docker
        // call and no file write can have happened before the name was rejected.
        expect(tarSourceCalls).toBe(0);
        expect(existsSync(archivePath)).toBe(false);
        expect(existsSync(`${archivePath}.part`)).toBe(false);
        expect(readdirSync(directory)).toEqual([]);
      } finally {
        // The name is Engine-invalid; the empty directory asserted above proves nothing leaked.
        removeTestVolume(volumeName);
      }
    },
  );
});
