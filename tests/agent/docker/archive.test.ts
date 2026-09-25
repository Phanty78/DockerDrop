import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { createVolumeArchive } from "../../../src/agent/docker/archive";
import {
  ZSTD_FRAME_MAGIC,
  VolumeArchiveError,
  type VolumeArchiveDeps,
  type VolumeArchiveErrorCode,
  type VolumeArchiveOptions,
  type VolumeTarSource,
} from "../../../src/agent/docker/archive.types";

/**
 * Contract under test: `createVolumeArchive` streams `tarSource(volumeName)` through zstd into
 * `outputPath + ".part"`, renames it to `outputPath` only once the transfer succeeded, and never
 * leaves a partial archive behind on failure. The tar source is injected: no Docker CLI is
 * contacted by the unit tests, the reference tar is replayed from `tests/fixtures/volume`.
 */

/** Reference volume whose contents the fake tar source replays. */
const FIXTURE_DIR = join(import.meta.dir, "../../fixtures/volume");

/** Entries `tar -C <fixture> -cf - .` produces, in bsdtar order. */
const FIXTURE_ENTRIES = ["./", "./README.txt", "./data/", "./data/config.json", "./data/notes.md"];

/** Files of the fixture volume compared byte for byte after extraction. */
const FIXTURE_FILES = ["README.txt", "data/config.json", "data/notes.md"];

/** Tar block size; the fixture tar length is a multiple of it, so the chunks stay aligned. */
const CHUNK_SIZE = 512;

/** Builds the reference tar of the fixture volume with the system tar. */
function buildFixtureTar(): Buffer {
  const result = Bun.spawnSync(["tar", "-C", FIXTURE_DIR, "-cf", "-", "."]);

  if (result.exitCode !== 0) {
    throw new Error(`fixture tar failed: ${result.stderr.toString()}`);
  }

  return result.stdout;
}

let fixtureTarCache: Buffer | null = null;

/**
 * Reference tar of the fixture volume, built on first use so a broken fixture fails named tests,
 * not the import.
 */
function fixtureTar(): Buffer {
  if (fixtureTarCache === null) {
    fixtureTarCache = buildFixtureTar();
  }

  return fixtureTarCache;
}

/** Splits `bytes` into 512-byte chunks so the archive code is fed progressively. */
function toChunks(bytes: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    chunks.push(bytes.subarray(offset, offset + CHUNK_SIZE));
  }

  return chunks;
}

/** Fake tar producer plus the volume names the archive code requested, in call order. */
interface FakeTarSource {
  readonly source: VolumeTarSource;
  readonly requestedVolumes: string[];
}

/**
 * Builds a `VolumeTarSource` replaying `bytes` in 512-byte chunks.
 * `closeError` makes `close()` reject (failed `docker run`), `breakAfterChunks` makes the stream
 * fail after that many chunks (broken transfer); both default to a clean, complete transfer.
 */
function fakeSource(
  bytes: Uint8Array,
  options: {
    readonly closeError?: Error;
    readonly breakAfterChunks?: number;
    readonly breakError?: Error;
  } = {},
): FakeTarSource {
  const requestedVolumes: string[] = [];
  const closeError = options.closeError;
  const breakAfterChunks = options.breakAfterChunks;
  const breakError = options.breakError;

  const source: VolumeTarSource = (volumeName) => {
    requestedVolumes.push(volumeName);
    const chunks = toChunks(bytes);
    let index = 0;

    return {
      bytes: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (breakAfterChunks !== undefined && index >= breakAfterChunks) {
            controller.error(breakError ?? new Error("tar stream broken"));
            return;
          }

          const chunk = chunks[index];

          if (chunk === undefined) {
            controller.close();
            return;
          }

          index += 1;
          controller.enqueue(chunk);
        },
      }),
      close:
        closeError === undefined
          ? () => Promise.resolve()
          : () => Promise.reject(closeError),
    };
  };

  return { source, requestedVolumes };
}

/** Temp directory created by the current test; removed in `afterEach`. */
let currentTempDir: string | null = null;

/** Creates a fresh `dd-archive-*` directory under the OS temp dir and registers it for cleanup. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dd-archive-"));
  currentTempDir = dir;
  return dir;
}

afterEach(() => {
  if (currentTempDir !== null) {
    rmSync(currentTempDir, { recursive: true, force: true });
    currentTempDir = null;
  }
});

/** Asserts that neither the archive nor the intermediate `.part` file exist. */
function expectNoArchiveLeft(outputPath: string): void {
  expect(existsSync(outputPath)).toBe(false);
  expect(existsSync(`${outputPath}.part`)).toBe(false);
}

/** Records how a promise settled, so a test can prove a call rejected instead of resolving. */
async function settle(
  promise: Promise<unknown>,
): Promise<{ readonly status: "resolved" | "rejected"; readonly error: unknown }> {
  try {
    await promise;
    return { status: "resolved", error: null };
  } catch (error) {
    return { status: "rejected", error };
  }
}

/**
 * Runs `createVolumeArchive` and asserts it REJECTS (never resolves) with a `VolumeArchiveError`
 * carrying `code`, while leaving neither the archive nor its `.part` file behind.
 */
async function captureArchiveError(
  options: VolumeArchiveOptions,
  deps: VolumeArchiveDeps,
  code: VolumeArchiveErrorCode,
): Promise<VolumeArchiveError> {
  const settlement = await settle(createVolumeArchive(options, deps));

  // A resolution is a failure here: it would report a broken archive as a success.
  expect(settlement.status).toBe("rejected");
  expect(settlement.error).toBeInstanceOf(VolumeArchiveError);

  const error = settlement.error as VolumeArchiveError;
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);
  expectNoArchiveLeft(options.outputPath);

  return error;
}

/** Decompresses the archive at `outputPath` into `<dir>/archive.tar` and returns that tar path. */
function decompressArchive(outputPath: string, dir: string): string {
  const tarPath = join(dir, "archive.tar");
  writeFileSync(tarPath, zstdDecompressSync(readFileSync(outputPath)));
  return tarPath;
}

/** Entries of the tar at `tarPath`, as `tar -tf` lists them (empty list for an empty tar). */
function listTarEntries(tarPath: string): string[] {
  const result = Bun.spawnSync(["tar", "-tf", tarPath]);

  expect(result.exitCode).toBe(0);

  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => line !== "");
}

describe("createVolumeArchive", () => {
  describe("archive nominale", () => {
    it("écrit une archive zstd à outputPath, renvoie sa taille et ne laisse aucun .part", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const { source } = fakeSource(fixtureTar());

      const result = await createVolumeArchive(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: source },
      );

      expect(result.archivePath).toBe(outputPath);
      expect(result.archiveSize).toBeGreaterThan(0);
      expect(Object.keys(result).sort()).toEqual(["archivePath", "archiveSize"]);

      const archive = readFileSync(outputPath);
      expect(archive.length).toBe(result.archiveSize);
      expect([...archive.subarray(0, 4)]).toEqual([...ZSTD_FRAME_MAGIC]);
      expect(existsSync(`${outputPath}.part`)).toBe(false);
    });

    it("conserve à l'octet près les fichiers du volume dans l'archive", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const extractDir = join(dir, "extracted");
      mkdirSync(extractDir);

      await createVolumeArchive(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: fakeSource(fixtureTar()).source },
      );

      const tarPath = decompressArchive(outputPath, dir);
      const extraction = Bun.spawnSync(["tar", "-C", extractDir, "-xf", tarPath]);
      expect(extraction.exitCode).toBe(0);

      for (const relativePath of FIXTURE_FILES) {
        expect(
          readFileSync(join(extractDir, relativePath)).equals(
            readFileSync(join(FIXTURE_DIR, relativePath)),
          ),
        ).toBe(true);
      }
    });

    it("liste les entrées ./README.txt, ./data/… du volume dans l'archive décompressée", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");

      await createVolumeArchive(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: fakeSource(fixtureTar()).source },
      );

      expect(listTarEntries(decompressArchive(outputPath, dir))).toEqual(FIXTURE_ENTRIES);
    });
  });

  describe("validation du nom de volume", () => {
    it("accepte un nom entouré d'espaces et transmet le nom trimé à la source tar", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const fake = fakeSource(fixtureTar());

      const result = await createVolumeArchive(
        { volumeName: "  mysql_client_x  ", outputPath },
        { tarSource: fake.source },
      );

      expect(fake.requestedVolumes).toEqual(["mysql_client_x"]);
      expect(result.archivePath).toBe(outputPath);
      expect(existsSync(outputPath)).toBe(true);
    });

    const invalidNames = [
      { label: "vide", volumeName: "" },
      { label: "uniquement composé d'espaces", volumeName: "   " },
      { label: "commençant par un tiret", volumeName: "-bad" },
      { label: "contenant une espace", volumeName: "has space" },
      { label: "contenant un slash", volumeName: "a/b" },
    ] as const;

    for (const { label, volumeName } of invalidNames) {
      it(`rejette VOLUME_NAME_INVALID pour un nom ${label}`, async () => {
        const dir = await makeTempDir();
        const outputPath = join(dir, "volume.tar.zst");
        const fake = fakeSource(fixtureTar());

        const error = await captureArchiveError(
          { volumeName, outputPath },
          { tarSource: fake.source },
          "VOLUME_NAME_INVALID",
        );

        // The rejected value is named in the message and no volume was ever read.
        expect(error.message).toContain(JSON.stringify(volumeName));
        expect(fake.requestedVolumes).toEqual([]);
      });
    }
  });

  describe("échecs de lecture du volume", () => {
    it("rejette VOLUME_TAR_FAILED en conservant le message et le code de sortie de close()", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const { source } = fakeSource(fixtureTar(), {
        closeError: new Error(
          'docker run alpine:3 tar failed with exit code 1: Error response from daemon: get mysql_client_x: no such volume',
        ),
      });

      const error = await captureArchiveError(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: source },
        "VOLUME_TAR_FAILED",
      );

      expect(error.message).toContain("exit code 1");
      expect(error.message).toContain("no such volume");
    });

    it("rejette VOLUME_TAR_FAILED quand le flux tar se rompt en cours de transfert", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const { source } = fakeSource(fixtureTar(), {
        breakAfterChunks: 3,
        breakError: new Error("docker run interrupted: stream closed unexpectedly"),
      });

      const error = await captureArchiveError(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: source },
        "VOLUME_TAR_FAILED",
      );

      expect(error.message).toContain("stream closed unexpectedly");
    });

    it("rejette VOLUME_TAR_FAILED quand la source tar elle-même échoue", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const failingSource: VolumeTarSource = (volumeName) => {
        throw new Error(`docker binary not found for ${volumeName}`);
      };

      const error = await captureArchiveError(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: failingSource },
        "VOLUME_TAR_FAILED",
      );

      expect(error.message).toContain("docker binary not found");
      expect(error.message).toContain("mysql_client_x");
    });
  });

  describe("écriture impossible", () => {
    it("rejette ARCHIVE_WRITE_FAILED quand le dossier de sortie n'existe pas", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "missing", "volume.tar.zst");
      const { source } = fakeSource(fixtureTar());

      const error = await captureArchiveError(
        { volumeName: "mysql_client_x", outputPath },
        { tarSource: source },
        "ARCHIVE_WRITE_FAILED",
      );

      // The message names the target and preserves the originating filesystem detail.
      expect(error.message).toContain(outputPath);
      expect(error.message).toContain("ENOENT");
    });

    it("rejette ARCHIVE_WRITE_FAILED quand outputPath existe déjà comme répertoire (rename impossible)", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      mkdirSync(outputPath); // rename() onto an existing directory fails (EISDIR).
      const { source } = fakeSource(fixtureTar());

      // captureArchiveError cannot be used here: its "nothing left at outputPath" check cannot
      // hold, since the blocking directory IS outputPath. The rename failure is still asserted to
      // reject, never resolve.
      const settlement = await settle(
        createVolumeArchive({ volumeName: "mysql_client_x", outputPath }, { tarSource: source }),
      );

      expect(settlement.status).toBe("rejected");
      expect(settlement.error).toBeInstanceOf(VolumeArchiveError);

      const error = settlement.error as VolumeArchiveError;
      expect(error.code).toBe("ARCHIVE_WRITE_FAILED");

      // The message names the target and the failed syscall: the .part open failure the ENOENT
      // test covers would pass a bare `toContain(outputPath)` too, since the .part path contains it.
      expect(error.message).toContain(outputPath);
      expect(error.message).toContain("rename");
      // The .part is cleaned up; the pre-existing directory at outputPath stays untouched.
      expect(existsSync(`${outputPath}.part`)).toBe(false);
      expect(existsSync(outputPath)).toBe(true);
    });
  });

  describe("volume vide", () => {
    it("produit une archive valide, de taille non nulle et sans entrée, pour un volume vide", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const { source } = fakeSource(new Uint8Array(0));

      const result = await createVolumeArchive(
        { volumeName: "empty_volume", outputPath },
        { tarSource: source },
      );

      expect(result.archivePath).toBe(outputPath);
      expect(result.archiveSize).toBeGreaterThan(0);
      expect(existsSync(`${outputPath}.part`)).toBe(false);

      const archive = readFileSync(outputPath);
      expect([...archive.subarray(0, 4)]).toEqual([...ZSTD_FRAME_MAGIC]);

      const tarPath = decompressArchive(outputPath, dir);
      expect(zstdDecompressSync(archive).length).toBe(0);
      expect(listTarEntries(tarPath)).toEqual([]);
    });
  });
});
