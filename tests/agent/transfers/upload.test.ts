import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { uploadArchiveToS3 } from "../../../src/agent/transfers/upload";
import { SourceTransferError } from "../../../src/agent/transfers/source-transfer.types";
import type {
  FetchLike,
  SourceTransferErrorCode,
  UploadArchiveDeps,
} from "../../../src/agent/transfers/source-transfer.types";

/**
 * Contract under test: `uploadArchiveToS3` PUTs the archive at `archivePath` directly to the
 * presigned URL. The binary goes to S3 only, streamed through a counting `TransformStream` that
 * reports progress per chunk without ever reading the archive fully into memory, the last call
 * being `(total, total)` — `(0, 0)` for an empty archive. The PUT declares the exact file size as
 * `Content-Length`, never asking for chunked framing, and the returned `uploadedBytes` is that
 * exact size; every failure rejects with an explicit `SourceTransferError` instead of a false
 * success. `fetchImpl` is faked: no network is contacted.
 */

/**
 * Archive size used by the tests: Bun streams a 1 MiB file in several chunks (256–512 KiB each),
 * so the counting TransformStream sees multiple chunks. The +17 tail keeps the last chunk partial,
 * proving the final progress call carries the exact file size, not a rounded chunk boundary.
 */
const FIXTURE_SIZE = 1024 * 1024 + 17;

/** Presigned URL that the PUT must receive untouched, query string included. */
const UPLOAD_URL = "https://s3.example.test/dockerdrop/volume.tar.zst?X-Amz-Signature=abc123";

/** Deterministic archive bytes; the pattern itself does not matter, only that it stays stable. */
function fixtureBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }

  return bytes;
}

/** Runs `test` inside a fresh `dd-upload-*` temp directory, removed in `finally` whatever happens. */
async function withTempDir<T>(test: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dd-upload-"));

  try {
    return await test(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `test` against a real archive of `size` deterministic bytes, then removes the temp dir. */
async function withArchiveFixture<T>(
  size: number,
  test: (archivePath: string, bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  return withTempDir(async (dir) => {
    const archivePath = join(dir, "volume.tar.zst");
    const bytes = fixtureBytes(size);
    writeFileSync(archivePath, bytes);

    return test(archivePath, bytes);
  });
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
 * Runs `uploadArchiveToS3` and asserts it REJECTS (never resolves) with a `SourceTransferError`
 * carrying `code`: a resolution here would report a failed upload as a success.
 */
async function captureUploadError(
  archivePath: string,
  uploadUrl: string,
  deps: UploadArchiveDeps,
  code: SourceTransferErrorCode,
): Promise<SourceTransferError> {
  const settlement = await settle(uploadArchiveToS3(archivePath, uploadUrl, deps));

  expect(settlement.status).toBe("rejected");
  expect(settlement.error).toBeInstanceOf(SourceTransferError);

  const error = settlement.error as SourceTransferError;
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);

  return error;
}

/** One PUT the uploader sent, with its body drained exactly like a real transport would. */
interface CapturedUpload {
  readonly url: string;
  readonly method: string | undefined;
  /** True when `init.body` was a `ReadableStream`, i.e. the archive was streamed, not buffered. */
  readonly bodyIsStream: boolean;
  /** Raw `init.headers` the uploader declared; `undefined` when it declared none. */
  readonly headers: HeadersInit | undefined;
  readonly bodyBytes: Uint8Array;
}

/** Request URL of the fetch input, whichever shape the uploader passes. */
function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

/** Drains a `ReadableStream` fully and concatenates it, like a transport sending the request. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    chunks.push(value);
    receivedBytes += value.byteLength;
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/**
 * Fake transport recording every PUT: it drains `init.body` (the uploader's wrapped archive
 * stream) into `bodyBytes` and answers with `respond()`, so a test can inspect both what was sent
 * to S3 and how the uploader maps the answer.
 */
function capturingFetch(respond: () => Response): {
  readonly fetchImpl: FetchLike;
  readonly uploads: CapturedUpload[];
} {
  const uploads: CapturedUpload[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const body = init?.body;
    const bodyIsStream = body instanceof ReadableStream;
    const bodyBytes = bodyIsStream ? await collectStream(body) : new Uint8Array(0);

    uploads.push({
      url: requestUrl(input),
      method: init?.method,
      bodyIsStream,
      headers: init?.headers,
      bodyBytes,
    });

    return respond();
  };

  return { fetchImpl, uploads };
}

/** The single captured PUT, asserted to exist; keeps the type narrowing out of the tests. */
function onlyUpload(uploads: CapturedUpload[]): CapturedUpload {
  expect(uploads.length).toBe(1);
  const upload = uploads[0];

  if (upload === undefined) {
    throw new Error("expected exactly one captured PUT");
  }

  return upload;
}

/** Asserts byte-for-byte equality and reports the offset of the first differing byte. */
function expectSameBytes(received: Uint8Array, expected: Uint8Array): void {
  expect(received.length).toBe(expected.length);

  const expectedBuffer = Buffer.from(expected);
  const firstDifference = Buffer.from(received).findIndex(
    (byte, index) => byte !== expectedBuffer[index],
  );

  expect(firstDifference).toBe(-1);
}

describe("uploadArchiveToS3", () => {
  it("envoie l'archive par PUT direct à l'URL presignée", async () => {
    await withArchiveFixture(FIXTURE_SIZE, async (archivePath, bytes) => {
      const { fetchImpl, uploads } = capturingFetch(() => new Response(null, { status: 200 }));

      const result = await uploadArchiveToS3(archivePath, UPLOAD_URL, { fetchImpl });

      const upload = onlyUpload(uploads);
      expect(upload.url).toBe(UPLOAD_URL);
      expect(upload.method).toBe("PUT");
      // The archive must reach S3 as a stream, not as a buffered blob or byte array.
      expect(upload.bodyIsStream).toBe(true);
      expectSameBytes(upload.bodyBytes, bytes);

      // Real S3 answers 411 MissingContentLength to a chunked PUT, so the exact size must be
      // declared; without it a body stream ending early would also be stored truncated.
      const requestHeaders = new Headers(upload.headers);
      expect(requestHeaders.get("Content-Length")).toBe(String(bytes.length));
      // The uploader declares the size itself instead of asking for chunked framing.
      expect(requestHeaders.get("transfer-encoding")).toBeNull();
      expect(result).toEqual({ uploadedBytes: bytes.length });
    });
  });

  it("remonte la progression par octets pendant l'upload", async () => {
    await withArchiveFixture(FIXTURE_SIZE, async (archivePath, bytes) => {
      const progress: Array<readonly [number, number]> = [];
      const { fetchImpl, uploads } = capturingFetch(() => new Response(null, { status: 200 }));

      const result = await uploadArchiveToS3(archivePath, UPLOAD_URL, {
        fetchImpl,
        onProgress: (bytesUploaded, totalBytes) => progress.push([bytesUploaded, totalBytes]),
      });

      onlyUpload(uploads);
      // A 1 MiB archive reaches the counter in several chunks: one call would prove nothing.
      expect(progress.length).toBeGreaterThanOrEqual(2);

      let previousBytes = 0;
      for (const [bytesUploaded, totalBytes] of progress) {
        expect(totalBytes).toBe(bytes.length);
        expect(bytesUploaded).toBeGreaterThan(previousBytes);
        previousBytes = bytesUploaded;
      }

      expect(previousBytes).toBe(bytes.length);
      expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
      expect(result).toEqual({ uploadedBytes: bytes.length });
    });
  });

  it("remonte la progression pour une archive vide", async () => {
    await withArchiveFixture(0, async (archivePath) => {
      const progress: Array<readonly [number, number]> = [];
      const { fetchImpl, uploads } = capturingFetch(() => new Response(null, { status: 200 }));

      const result = await uploadArchiveToS3(archivePath, UPLOAD_URL, {
        fetchImpl,
        onProgress: (bytesUploaded, totalBytes) => progress.push([bytesUploaded, totalBytes]),
      });

      const upload = onlyUpload(uploads);
      // No chunk ever crosses the counting stream for an empty archive, so the contract's final
      // `(total, total)` call must be emitted explicitly and exactly once.
      expect(progress).toEqual([[0, 0]]);
      expectSameBytes(upload.bodyBytes, new Uint8Array(0));
      expect(new Headers(upload.headers).get("Content-Length")).toBe("0");
      expect(result).toEqual({ uploadedBytes: 0 });
    });
  });

  it("refuse un faux succès sur un refus S3", async () => {
    await withArchiveFixture(FIXTURE_SIZE, async (archivePath) => {
      const cases = [
        { status: 403, statusText: "Forbidden", body: "SignatureDoesNotMatch" },
        { status: 500, statusText: "Internal Server Error", body: "internal error" },
      ] as const;

      for (const { status, statusText, body } of cases) {
        const { fetchImpl, uploads } = capturingFetch(
          () => new Response(body, { status, statusText }),
        );

        const error = await captureUploadError(
          archivePath,
          UPLOAD_URL,
          { fetchImpl },
          "S3_UPLOAD_REJECTED",
        );

        onlyUpload(uploads);
        expect(error.message).toContain(String(status));
        expect(error.message).toContain(statusText);
        // The raw S3 body stays in the message, truncated to a log-sized detail.
        expect(error.message).toContain(body);
      }
    });
  });

  it("remonte l'échec réseau comme une erreur explicite", async () => {
    await withArchiveFixture(FIXTURE_SIZE, async (archivePath) => {
      const { fetchImpl, uploads } = capturingFetch(() => {
        throw new Error("ECONNREFUSED");
      });

      const error = await captureUploadError(
        archivePath,
        UPLOAD_URL,
        { fetchImpl },
        "S3_UPLOAD_REQUEST_FAILED",
      );

      onlyUpload(uploads);
      expect(error.message).toContain("ECONNREFUSED");
    });
  });

  it("refuse un faux succès si le flux s'interrompt en cours d'upload", async () => {
    await withArchiveFixture(FIXTURE_SIZE, async (archivePath) => {
      let consumedFirstChunk = false;

      const brokenFetch: FetchLike = async (_input, init) => {
        const stream = init?.body;

        if (stream instanceof ReadableStream) {
          // Start draining, like a transport that already sent the beginning of the body…
          await stream.getReader().read();
          consumedFirstChunk = true;
        }

        // …then the connection breaks before the whole archive made it through.
        throw new Error("stream-broken");
      };

      const error = await captureUploadError(
        archivePath,
        UPLOAD_URL,
        { fetchImpl: brokenFetch },
        "S3_UPLOAD_REQUEST_FAILED",
      );

      // The failure struck mid-upload, after bytes had already been streamed out…
      expect(consumedFirstChunk).toBe(true);
      // …and the transport error stays in the message instead of a false success.
      expect(error.message).toContain("stream-broken");
    });
  });

  it("refuse un fichier d'archive absent", async () => {
    await withTempDir(async (dir) => {
      const missingPath = join(dir, "absent-archive.tar.zst");
      const { fetchImpl, uploads } = capturingFetch(() => new Response(null, { status: 200 }));

      const error = await captureUploadError(
        missingPath,
        UPLOAD_URL,
        { fetchImpl },
        "S3_UPLOAD_REQUEST_FAILED",
      );

      expect(error.message).toContain(missingPath);
      // Nothing is sent when the archive cannot even be opened.
      expect(uploads.length).toBe(0);
    });
  });
});
