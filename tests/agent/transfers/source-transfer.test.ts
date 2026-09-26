import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import {
  ZSTD_FRAME_MAGIC,
  VolumeArchiveError,
  type VolumeTarSource,
} from "../../../src/agent/docker/archive.types";
import { createHttpTransferClient } from "../../../src/agent/transfers/client";
import { runSourceTransfer } from "../../../src/agent/transfers/source-transfer";
import {
  SourceTransferError,
  type CreateTransferRequest,
  type SourceTransferClient,
  type SourceTransferErrorCode,
  type SourceTransferProgress,
  type SourceTransferResult,
  type SourceTransferStatus,
  type UploadArchiveToS3,
} from "../../../src/agent/transfers/source-transfer.types";

/**
 * Contract under test: `runSourceTransfer` drives §6 steps 3–5 of one transfer. It creates the
 * transfer, reports `preparing` while `createVolumeArchive` builds the archive for real, reports
 * `uploading` while the injected uploader sends the archive straight to S3, and confirms `ready`
 * with the exact on-disk archive size — only after the upload succeeded. Any failure reports
 * `failed` (best effort) and rethrows the original error: no false success, no ready
 * (§16.7). There is no resume state: a relaunch is a fresh run.
 *
 * The unit tests inject both ports (client + uploader); the end-to-end tests run the real HTTP
 * client and the real uploader against a fake backend and a fake S3 served by `Bun.serve`.
 */

const RECIPIENT_USER_ID = "thomas";
const VOLUME_NAME = "mysql_client_x";
const EXPIRES_AT = "2026-09-27T00:00:00.000Z";

/**
 * Deterministic multi-chunk "tar" payload: xorshift32 noise, so the bytes are non-periodic and
 * therefore incompressible. A repeating pattern would shrink the compressed archive below the
 * 1 KiB body guard of the end-to-end test, letting its "the backend never transports the archive"
 * assertion pass even on a regression.
 */
function payloadBytes(sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  let state = 0x9e3779b9;

  for (let index = 0; index < sizeBytes; index += 1) {
    // xorshift32 (Marsaglia): one step of the 32-bit state per byte, so no short cycle repeats.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;

    bytes[index] = state & 0xff;
  }

  return bytes;
}

/** 8 KB payload, a multiple of `TAR_CHUNK_SIZE`: several chunks, and over 1 KiB once compressed. */
const TAR_PAYLOAD = payloadBytes(8 * 1024);

/** Chunk size of the fake tar stream: a divisor of the payload, so every chunk but the last is full. */
const TAR_CHUNK_SIZE = 512;

/** Fake tar producer plus the volume names the archive code requested, in call order. */
interface FakeTarSource {
  readonly source: VolumeTarSource;
  readonly requestedVolumes: string[];
}

/**
 * Builds a `VolumeTarSource` replaying `bytes` in 512-byte chunks. `breakAfterChunks` makes the
 * stream fail after that many chunks (broken transfer); by default the transfer is clean.
 */
function fakeTarSource(
  bytes: Uint8Array,
  options: { readonly breakAfterChunks?: number; readonly breakError?: Error } = {},
): FakeTarSource {
  const requestedVolumes: string[] = [];
  const { breakAfterChunks, breakError } = options;

  const source: VolumeTarSource = (volumeName) => {
    requestedVolumes.push(volumeName);
    const chunks: Uint8Array[] = [];

    for (let offset = 0; offset < bytes.length; offset += TAR_CHUNK_SIZE) {
      chunks.push(bytes.subarray(offset, offset + TAR_CHUNK_SIZE));
    }

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
      close: () => Promise.resolve(),
    };
  };

  return { source, requestedVolumes };
}

/** One recorded client call, in order: creation or a §9.4 status change. */
type RecordedCall =
  | { readonly kind: "createTransfer"; readonly request: CreateTransferRequest }
  | {
      readonly kind: "updateStatus";
      readonly transferId: string;
      readonly status: SourceTransferStatus;
      readonly archiveSize: number | undefined;
    };

/** Fake `SourceTransferClient` plus every call it recorded, in order. */
interface FakeClient {
  readonly client: SourceTransferClient;
  readonly calls: RecordedCall[];
}

/**
 * Builds a recording `SourceTransferClient`. `ids` mints one id per `createTransfer` call,
 * `createError` makes creation reject, `statusErrors` makes specific status changes reject, and
 * `events` receives one label per call so tests can assert the total order across all fakes.
 */
function fakeClient(
  options: {
    readonly ids?: readonly string[];
    readonly createError?: Error;
    readonly statusErrors?: Partial<Record<SourceTransferStatus, Error>>;
    readonly events?: string[];
  } = {},
): FakeClient {
  const calls: RecordedCall[] = [];
  const ids = options.ids ?? ["tr_fake_1"];
  let creations = 0;

  const client: SourceTransferClient = {
    async createTransfer(request) {
      calls.push({ kind: "createTransfer", request });
      options.events?.push("createTransfer");

      if (options.createError !== undefined) {
        throw options.createError;
      }

      const id = ids[creations] ?? `tr_fake_${creations + 1}`;
      creations += 1;

      // Mirrors the §9.3 S3 key shape: docker-volume-transfers/{transferId}/volume.tar.zst.
      return {
        id,
        uploadUrl: `https://s3.example.test/docker-volume-transfers/${id}/volume.tar.zst?signature=abc`,
        expiresAt: EXPIRES_AT,
      };
    },
    async updateStatus(transferId, status, archiveSize) {
      calls.push({ kind: "updateStatus", transferId, status, archiveSize });
      options.events?.push(`updateStatus:${status}`);

      const error = options.statusErrors?.[status];

      if (error !== undefined) {
        throw error;
      }
    },
  };

  return { client, calls };
}

/** Fake `UploadArchiveToS3` plus the pairs it received, in call order. */
interface FakeUpload {
  readonly upload: UploadArchiveToS3;
  readonly calls: Array<{ readonly archivePath: string; readonly uploadUrl: string }>;
}

/**
 * Builds a fake uploader that records its arguments, replays `progress` through `deps.onProgress`,
 * then either rejects with `error` or resolves with `uploadedBytes` (defaults to the real archive
 * size on disk). `events` receives one label per step for the total-order assertions.
 */
function fakeUpload(
  options: {
    readonly progress?: ReadonlyArray<readonly [number, number]>;
    readonly uploadedBytes?: number;
    readonly error?: Error;
    readonly events?: string[];
  } = {},
): FakeUpload {
  const calls: FakeUpload["calls"] = [];
  const progress = options.progress ?? [];

  const upload: UploadArchiveToS3 = async (archivePath, uploadUrl, deps) => {
    calls.push({ archivePath, uploadUrl });
    options.events?.push("upload:start");

    for (const [bytesUploaded, totalBytes] of progress) {
      deps?.onProgress?.(bytesUploaded, totalBytes);
    }

    if (options.error !== undefined) {
      options.events?.push("upload:rejected");
      throw options.error;
    }

    options.events?.push("upload:done");

    return { uploadedBytes: options.uploadedBytes ?? statSync(archivePath).size };
  };

  return { upload, calls };
}

/** Progress event of the frozen callback, recorded for assertions. */
type ProgressEvent = Parameters<SourceTransferProgress>[0];

/**
 * Records progress events and, when `events` is given, mirrors them into the shared order log with
 * a label naming the phase and the uploaded byte count.
 */
function recordProgress(events?: string[]): {
  readonly onProgress: SourceTransferProgress;
  readonly events: ProgressEvent[];
} {
  const recorded: ProgressEvent[] = [];

  return {
    onProgress(event) {
      recorded.push(event);

      if (events !== undefined) {
        const suffix = event.bytesUploaded === undefined ? "" : `:${event.bytesUploaded}`;
        events.push(`progress:${event.phase}${suffix}`);
      }
    },
    events: recorded,
  };
}

/** Labels of every recorded client call, in order (creation included), for exact-order assertions. */
function recordedSequence(client: FakeClient): string[] {
  return client.calls.map((call) => (call.kind === "createTransfer" ? "createTransfer" : call.status));
}

/** `ready` confirmations recorded by the fake client, with the size each one carried. */
function readyConfirmations(client: FakeClient): Array<{
  readonly transferId: string;
  readonly archiveSize: number | undefined;
}> {
  return client.calls.flatMap((call) =>
    call.kind === "updateStatus" && call.status === "ready"
      ? [{ transferId: call.transferId, archiveSize: call.archiveSize }]
      : [],
  );
}

/** Temp directory created by the current test; removed in `afterEach`. */
let currentTempDir: string | null = null;

/** Creates a fresh `dd-transfer-*` directory under the OS temp dir and registers it for cleanup. */
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dd-transfer-"));
  currentTempDir = dir;
  return dir;
}

afterEach(() => {
  if (currentTempDir !== null) {
    rmSync(currentTempDir, { recursive: true, force: true });
    currentTempDir = null;
  }
});

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

/** Runs a transfer and asserts it REJECTS (never resolves), returning the thrown error. */
async function captureRunError(run: Promise<SourceTransferResult>): Promise<unknown> {
  const settlement = await settle(run);

  // A resolution is a failure here: it would report a broken transfer as a success.
  expect(settlement.status).toBe("rejected");

  return settlement.error;
}

/** Asserts `error` is a `SourceTransferError` carrying `code`, and returns it for the message check. */
function expectSourceTransferError(
  error: unknown,
  code: SourceTransferErrorCode,
): SourceTransferError {
  expect(error).toBeInstanceOf(SourceTransferError);

  const transferError = error as SourceTransferError;
  expect(transferError.code).toBe(code);
  expect(transferError.message.length).toBeGreaterThan(0);

  return transferError;
}

describe("runSourceTransfer", () => {
  describe("transfert nominal", () => {
    it("conduit le transfert de bout en bout : preparing, upload, puis ready seulement après confirmation", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const events: string[] = [];
      const backend = fakeClient({ ids: ["tr_ok"], events });
      const { source, requestedVolumes } = fakeTarSource(TAR_PAYLOAD);
      const s3 = fakeUpload({ events });
      const progress = recordProgress();

      const result = await runSourceTransfer(
        { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
        {
          client: backend.client,
          upload: s3.upload,
          tarSource: source,
          onProgress: progress.onProgress,
        },
      );

      const archiveSize = statSync(outputPath).size;

      // The client saw exactly the four §9.4 calls, in order; `ready` carries the archive size.
      expect(backend.calls).toEqual([
        {
          kind: "createTransfer",
          request: { recipientUserId: RECIPIENT_USER_ID, volumeName: VOLUME_NAME },
        },
        { kind: "updateStatus", transferId: "tr_ok", status: "preparing", archiveSize: undefined },
        { kind: "updateStatus", transferId: "tr_ok", status: "uploading", archiveSize: undefined },
        { kind: "updateStatus", transferId: "tr_ok", status: "ready", archiveSize },
      ]);

      // Total order across all fakes: the upload runs after `uploading` and before `ready`.
      expect(events).toEqual([
        "createTransfer",
        "updateStatus:preparing",
        "updateStatus:uploading",
        "upload:start",
        "upload:done",
        "updateStatus:ready",
      ]);

      // The uploader received the archive built by the real `createVolumeArchive` and the URL.
      expect(s3.calls).toEqual([
        {
          archivePath: outputPath,
          uploadUrl: "https://s3.example.test/docker-volume-transfers/tr_ok/volume.tar.zst?signature=abc",
        },
      ]);
      expect(requestedVolumes).toEqual([VOLUME_NAME]);

      // The archive exists and is a real, complete zstd stream of the fake tar payload.
      expect(existsSync(outputPath)).toBe(true);
      const onDisk = readFileSync(outputPath);
      expect(Uint8Array.from(onDisk.subarray(0, 4))).toEqual(ZSTD_FRAME_MAGIC);
      expect(zstdDecompressSync(onDisk)).toEqual(Buffer.from(TAR_PAYLOAD));

      expect(result).toEqual({
        transferId: "tr_ok",
        archivePath: outputPath,
        archiveSize,
        uploadedBytes: archiveSize,
      });
      expect(Object.keys(result).sort()).toEqual([
        "archivePath",
        "archiveSize",
        "transferId",
        "uploadedBytes",
      ]);
    });

    it("confirme ready avec la taille exacte de l'archive", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const backend = fakeClient({ ids: ["tr_size"] });
      // Deliberately different from the archive size: the ready confirmation must come from the
      // archive on disk, never from the uploader's own byte count.
      const s3 = fakeUpload({ uploadedBytes: 999 });

      const result = await runSourceTransfer(
        { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
        { client: backend.client, upload: s3.upload, tarSource: fakeTarSource(TAR_PAYLOAD).source },
      );

      const archiveSize = statSync(outputPath).size;
      expect(archiveSize).toBeGreaterThan(0);
      expect(archiveSize).not.toBe(999);

      expect(readyConfirmations(backend)).toEqual([{ transferId: "tr_size", archiveSize }]);
      expect(result.archiveSize).toBe(archiveSize);
      expect(result.uploadedBytes).toBe(999);
    });
  });

  describe("progression", () => {
    it("remonte la progression pendant la préparation et l'upload", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const events: string[] = [];
      const backend = fakeClient({ ids: ["tr_progress"], events });
      const { source } = fakeTarSource(TAR_PAYLOAD);
      const s3 = fakeUpload({ progress: [[5, 10], [10, 10]], events });
      const progress = recordProgress(events);
      const archiveExistedAt: boolean[] = [];
      const onProgress: SourceTransferProgress = (event) => {
        progress.onProgress(event);
        archiveExistedAt.push(existsSync(outputPath));
      };

      await runSourceTransfer(
        { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
        { client: backend.client, upload: s3.upload, tarSource: source, onProgress },
      );

      const archiveSize = statSync(outputPath).size;

      // The phase events carry the byte totals; the uploader's own events are forwarded as-is.
      expect(progress.events).toEqual([
        { phase: "preparing" },
        { phase: "uploading", bytesUploaded: 0, totalBytes: archiveSize },
        { phase: "uploading", bytesUploaded: 5, totalBytes: 10 },
        { phase: "uploading", bytesUploaded: 10, totalBytes: 10 },
      ]);

      // `preparing` is reported while the archive is being built, i.e. before it exists.
      expect(archiveExistedAt).toEqual([false, true, true, true]);

      // Cumulative, strictly increasing byte counts (0 → 5 → 10) ending exactly at (total, total);
      // the exact list above pins those invariants, the uploader's own events being forwarded as-is.

      // Nothing is reported after the run settles: `ready` is the last thing that happens.
      expect(events).toEqual([
        "createTransfer",
        "progress:preparing",
        "updateStatus:preparing",
        "progress:uploading:0",
        "updateStatus:uploading",
        "upload:start",
        "progress:uploading:5",
        "progress:uploading:10",
        "upload:done",
        "updateStatus:ready",
      ]);

      const settledCount = progress.events.length;
      // Flush the microtask queue: anything the run had scheduled after settling would surface now.
      await Promise.resolve();
      expect(progress.events.length).toBe(settledCount);
    });
  });

  describe("échecs", () => {
    it("signale failed et ne produit aucun ready si l'archive échoue", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const events: string[] = [];
      const backend = fakeClient({ ids: ["tr_archive_fail"], events });
      const { source } = fakeTarSource(TAR_PAYLOAD, {
        breakAfterChunks: 2,
        breakError: new Error("tar stream broken"),
      });
      const s3 = fakeUpload();
      const progress = recordProgress(events);

      const failure = await captureRunError(
        runSourceTransfer(
          { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
          { client: backend.client, upload: s3.upload, tarSource: source, onProgress: progress.onProgress },
        ),
      );

      // The VolumeArchiveError of the archive step is reported unmasked, not converted.
      expect(failure).toBeInstanceOf(VolumeArchiveError);
      const archiveError = failure as VolumeArchiveError;
      expect(archiveError.code).toBe("VOLUME_TAR_FAILED");
      expect(archiveError.message).toContain("tar stream broken");

      expect(recordedSequence(backend)).toEqual(["createTransfer", "preparing", "failed"]);
      expect(readyConfirmations(backend)).toEqual([]);
      expect(s3.calls).toEqual([]);
      expect(progress.events).toEqual([{ phase: "preparing" }]);
      expect(events.at(-1)).toBe("updateStatus:failed");
      expect(existsSync(outputPath)).toBe(false);
      expect(existsSync(`${outputPath}.part`)).toBe(false);
    });

    it("signale failed et ne produit aucun ready si l'upload échoue", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const events: string[] = [];
      const uploadError = new SourceTransferError(
        "S3_UPLOAD_REJECTED",
        "S3 refused the upload with HTTP 403 SignatureDoesNotMatch",
      );
      const backend = fakeClient({ ids: ["tr_upload_fail"], events });
      const { source } = fakeTarSource(TAR_PAYLOAD);
      const s3 = fakeUpload({ progress: [[7, 9]], error: uploadError, events });
      const progress = recordProgress(events);

      const failure = await captureRunError(
        runSourceTransfer(
          { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
          { client: backend.client, upload: s3.upload, tarSource: source, onProgress: progress.onProgress },
        ),
      );

      // The uploader's error is rethrown as-is: no wrapping, no false success.
      expect(failure).toBe(uploadError);
      expect(recordedSequence(backend)).toEqual([
        "createTransfer",
        "preparing",
        "uploading",
        "failed",
      ]);
      expect(readyConfirmations(backend)).toEqual([]);
      expect(events.at(-1)).toBe("updateStatus:failed");

      // No progress after the failure: the last event is the byte count forwarded before it.
      const archiveSize = statSync(outputPath).size;
      expect(progress.events).toEqual([
        { phase: "preparing" },
        { phase: "uploading", bytesUploaded: 0, totalBytes: archiveSize },
        { phase: "uploading", bytesUploaded: 7, totalBytes: 9 },
      ]);

      const settledCount = progress.events.length;
      // Flush the microtask queue: anything the run had scheduled after settling would surface now.
      await Promise.resolve();
      expect(progress.events.length).toBe(settledCount);
    });

    it("ne masque pas l'erreur originale si le PATCH failed échoue aussi", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const uploadError = new SourceTransferError(
        "S3_UPLOAD_REJECTED",
        "S3 refused the upload with HTTP 403",
      );
      const cleanupError = new SourceTransferError(
        "TRANSFER_STATUS_UPDATE_FAILED",
        "PATCH failed was refused with HTTP 500",
      );
      const backend = fakeClient({ ids: ["tr_cleanup_fail"], statusErrors: { failed: cleanupError } });

      const failure = await captureRunError(
        runSourceTransfer(
          { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
          {
            client: backend.client,
            upload: fakeUpload({ error: uploadError }).upload,
            tarSource: fakeTarSource(TAR_PAYLOAD).source,
          },
        ),
      );

      // The cleanup failure is swallowed; the original upload error wins.
      expect(failure).toBe(uploadError);
      expect(recordedSequence(backend)).toEqual([
        "createTransfer",
        "preparing",
        "uploading",
        "failed",
      ]);
      expect(readyConfirmations(backend)).toEqual([]);
    });

    it("propage l'échec de création sans PATCH", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const createError = new SourceTransferError(
        "TRANSFER_CREATE_FAILED",
        "POST /transfers was refused with HTTP 500",
      );
      const backend = fakeClient({ createError });
      const s3 = fakeUpload();
      const progress = recordProgress();

      const failure = await captureRunError(
        runSourceTransfer(
          { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
          { client: backend.client, upload: s3.upload, tarSource: fakeTarSource(TAR_PAYLOAD).source, onProgress: progress.onProgress },
        ),
      );

      // Without an id there is nothing to report: the error crosses untouched and no local work ran.
      expect(failure).toBe(createError);
      expect(backend.calls).toEqual([
        {
          kind: "createTransfer",
          request: { recipientUserId: RECIPIENT_USER_ID, volumeName: VOLUME_NAME },
        },
      ]);
      expect(progress.events).toEqual([]);
      expect(s3.calls).toEqual([]);
      expect(existsSync(outputPath)).toBe(false);
    });
  });

  describe("relance", () => {
    it("une relance manuelle démarre un nouveau transfert", async () => {
      const dir = await makeTempDir();
      const firstOutputPath = join(dir, "first.tar.zst");
      const secondOutputPath = join(dir, "second.tar.zst");

      // First run: the archive is built, then S3 refuses the upload; the transfer ends failed.
      const firstBackend = fakeClient({ ids: ["tr_first"] });
      const firstUpload = fakeUpload({
        error: new SourceTransferError("S3_UPLOAD_REJECTED", "S3 refused the upload with HTTP 403"),
      });

      const firstFailure = await captureRunError(
        runSourceTransfer(
          { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath: firstOutputPath },
          {
            client: firstBackend.client,
            upload: firstUpload.upload,
            tarSource: fakeTarSource(TAR_PAYLOAD).source,
          },
        ),
      );

      expect(firstFailure).toBeInstanceOf(SourceTransferError);
      expect(recordedSequence(firstBackend)).toEqual([
        "createTransfer",
        "preparing",
        "uploading",
        "failed",
      ]);
      expect(recordedSequence(firstBackend)).not.toContain("ready");

      // 16.3 part-file contract: the failed run left no in-progress archive behind; the archive
      // step itself succeeded, so anything still there is a complete archive.
      expect(existsSync(`${firstOutputPath}.part`)).toBe(false);

      if (existsSync(firstOutputPath)) {
        expect(zstdDecompressSync(readFileSync(firstOutputPath))).toEqual(Buffer.from(TAR_PAYLOAD));
      }

      // Manual relaunch: a fresh client state mints a NEW transfer id; the run goes all the way.
      const secondBackend = fakeClient({ ids: ["tr_second"] });
      const secondUpload = fakeUpload();
      const progress = recordProgress();

      const result = await runSourceTransfer(
        { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath: secondOutputPath },
        {
          client: secondBackend.client,
          upload: secondUpload.upload,
          tarSource: fakeTarSource(TAR_PAYLOAD).source,
          onProgress: progress.onProgress,
        },
      );

      expect(result.transferId).toBe("tr_second");
      expect(result.transferId).not.toBe("tr_first");
      expect(recordedSequence(secondBackend)).toEqual([
        "createTransfer",
        "preparing",
        "uploading",
        "ready",
      ]);
      expect(existsSync(secondOutputPath)).toBe(true);
      expect(progress.events).toEqual([
        { phase: "preparing" },
        { phase: "uploading", bytesUploaded: 0, totalBytes: statSync(secondOutputPath).size },
      ]);
    });
  });

  describe("bout en bout simulé", () => {
    it("bout en bout simulé : agent → S3 fake → backend fake", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const s3 = startFakeS3(200);
      const backend = startFakeBackend(`${s3.origin}/docker-volume-transfers/tr_e2e_1/volume.tar.zst?signature=abc`);

      try {
        const client = createHttpTransferClient(backend.origin);

        const result = await runSourceTransfer(
          { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
          // No `upload`: the real `uploadArchiveToS3` runs against the fake S3.
          { client, tarSource: fakeTarSource(TAR_PAYLOAD).source },
        );

        // (a) S3 received exactly the archive file's bytes.
        const onDisk = readFileSync(outputPath);
        expect(s3.uploads).toHaveLength(1);
        const received = s3.uploads[0] ?? Buffer.alloc(0);
        expect(received).toEqual(onDisk);
        expect(Uint8Array.from(received.subarray(0, 4))).toEqual(ZSTD_FRAME_MAGIC);

        // (b) the backend saw POST then PATCH preparing, uploading, ready — in that order.
        expect(backend.requests.map((recorded) => `${recorded.method} ${recorded.path}`)).toEqual([
          "POST /transfers",
          `PATCH /transfers/${backend.transferId}`,
          `PATCH /transfers/${backend.transferId}`,
          `PATCH /transfers/${backend.transferId}`,
        ]);
        expect(backend.requests[0]?.json).toEqual({
          recipient_user_id: RECIPIENT_USER_ID,
          source_volume_name: VOLUME_NAME,
        });
        expect(backend.requests[1]?.json).toEqual({ status: "preparing" });
        expect(backend.requests[2]?.json).toEqual({ status: "uploading" });
        expect(backend.requests[3]?.json).toEqual({ status: "ready", archive_size: onDisk.length });

        // (c) §16.7 OK criterion: every backend request body is small JSON — the archive never
        // transits through the backend.
        for (const recorded of backend.requests) {
          expect(Buffer.byteLength(recorded.body, "utf8")).toBeLessThan(1024);
        }

        // (d) the run's result matches the archive and the transfer.
        expect(result).toEqual({
          transferId: backend.transferId,
          archivePath: outputPath,
          archiveSize: onDisk.length,
          uploadedBytes: onDisk.length,
        });
      } finally {
        await backend.stop();
        await s3.stop();
      }
    });

    it("bout en bout simulé : un refus S3 ne produit aucun ready", async () => {
      const dir = await makeTempDir();
      const outputPath = join(dir, "volume.tar.zst");
      const s3 = startFakeS3(403);
      const backend = startFakeBackend(`${s3.origin}/docker-volume-transfers/tr_e2e_1/volume.tar.zst?signature=abc`);

      try {
        const client = createHttpTransferClient(backend.origin);

        const failure = await captureRunError(
          runSourceTransfer(
            { volumeName: VOLUME_NAME, recipientUserId: RECIPIENT_USER_ID, outputPath },
            { client, tarSource: fakeTarSource(TAR_PAYLOAD).source },
          ),
        );

        expectSourceTransferError(failure, "S3_UPLOAD_REJECTED");
        expect((failure as SourceTransferError).message).toContain("403");

        const statuses = backend.requests.flatMap((recorded) =>
          recorded.method === "PATCH" ? [recorded.json["status"]] : [],
        );
        expect(statuses).toEqual(["preparing", "uploading", "failed"]);
        expect(statuses).not.toContain("ready");
      } finally {
        await backend.stop();
        await s3.stop();
      }
    });
  });
});

/** One request the fake backend received, body included so its size can be inspected. */
interface RecordedBackendRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly json: Record<string, unknown>;
}

/** Fake backend serving the two §9.3/§9.4 routes the source agent calls. */
interface FakeBackend {
  readonly origin: string;
  readonly transferId: string;
  readonly requests: RecordedBackendRequest[];
  stop(): Promise<void>;
}

/**
 * Starts a fake backend: `POST /transfers` answers 201 with the frozen §9.3 body, and
 * `PATCH /transfers/{id}` answers 200 echoing the requested status (plus `archive_size` when
 * present). Every request body is recorded so the test can prove its size stays small.
 */
function startFakeBackend(uploadUrl: string): FakeBackend {
  const transferId = "tr_e2e_1";
  const requests: RecordedBackendRequest[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = await request.text();
      requests.push({
        method: request.method,
        path: url.pathname,
        body,
        json: body === "" ? {} : (JSON.parse(body) as Record<string, unknown>),
      });

      if (request.method === "POST" && url.pathname === "/transfers") {
        return Response.json(
          {
            id: transferId,
            status: "created",
            storage: { upload: uploadUrl },
            expires_at: EXPIRES_AT,
          },
          { status: 201 },
        );
      }

      if (request.method === "PATCH" && url.pathname === `/transfers/${transferId}`) {
        const { status, archive_size: archiveSize } = JSON.parse(body) as {
          status: string;
          archive_size?: number;
        };

        return Response.json({
          id: transferId,
          status,
          ...(archiveSize === undefined ? {} : { archive_size: archiveSize }),
          expires_at: EXPIRES_AT,
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    transferId,
    requests,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}

/** Fake S3 accepting every PUT, recording the received bodies; `status` makes it refuse instead. */
interface FakeS3 {
  readonly origin: string;
  readonly uploads: Buffer[];
  stop(): Promise<void>;
}

/** Starts a fake S3: each PUT body is read fully (as the real uploader streams it) and recorded. */
function startFakeS3(status: number): FakeS3 {
  const uploads: Buffer[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      uploads.push(Buffer.from(await request.arrayBuffer()));

      return status === 200 ? new Response(null, { status }) : new Response("SignatureDoesNotMatch", { status });
    },
  });

  return {
    origin: `http://127.0.0.1:${server.port}`,
    uploads,
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
