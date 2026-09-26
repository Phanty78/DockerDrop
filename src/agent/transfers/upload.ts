/**
 * Task 16.7 — direct archive upload from the source agent to S3 (architecture §6 step 4).
 *
 * `uploadArchiveToS3` PUTs the finished archive straight to the temporary presigned URL: the binary
 * goes to S3 only, the backend never transports it. The file streams through a counting
 * `TransformStream`, so the archive is never fully read into memory and progress is reported per
 * chunk, the last call being exactly `(totalBytes, totalBytes)`. Every failure is an explicit,
 * loggable `SourceTransferError`: `S3_UPLOAD_REQUEST_FAILED` for a missing/unreadable archive or a
 * failed PUT transport, `S3_UPLOAD_REJECTED` for a non-2xx S3 answer (status, statusText and the
 * first characters of the S3 body kept for logs). `uploadedBytes` is returned only after a 2xx
 * answer, so no false success is ever reported.
 */

import { SourceTransferError } from "./source-transfer.types";
import type { UploadArchiveToS3 } from "./source-transfer.types";

/** Characters of an S3 error body kept in the message; enough to carry SignatureDoesNotMatch. */
const RESPONSE_DETAIL_LIMIT = 200;

/** Human-readable failure detail; filesystem errors keep their `code` (ENOENT, EACCES…) for logs. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const { code } = error as NodeJS.ErrnoException;
    const prefixed = typeof code === "string" && code !== "" && !error.message.startsWith(code);
    return prefixed ? `${code}: ${error.message}` : error.message;
  }

  return String(error);
}

/**
 * First characters of an S3 error body, for logs. Reading the body is best effort: a broken or
 * already-consumed body must never mask the rejection being reported.
 */
async function readResponseDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.length > RESPONSE_DETAIL_LIMIT ? `${text.slice(0, RESPONSE_DETAIL_LIMIT)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Uploads `archivePath` to the presigned URL with a single streaming PUT.
 *
 * Resolves with `{ uploadedBytes }` (the archive size on disk) only on a 2xx answer. Rejects with
 * `SourceTransferError("S3_UPLOAD_REQUEST_FAILED")` when the archive cannot be opened or when the
 * PUT itself fails (network error, invalid URL, broken body stream), and with
 * `SourceTransferError("S3_UPLOAD_REJECTED")` when S3 answers non-2xx.
 */
export const uploadArchiveToS3: UploadArchiveToS3 = async (archivePath, uploadUrl, deps) => {
  const file = Bun.file(archivePath);

  let totalBytes: number;
  try {
    // `Bun.file(path).size` is 0 for a missing file, so existence is checked explicitly: an
    // unreadable archive must never be uploaded as empty bytes and reported as a success.
    if (!(await file.exists())) {
      throw new Error("the file does not exist or is not readable");
    }

    totalBytes = file.size;
  } catch (error) {
    throw new SourceTransferError(
      "S3_UPLOAD_REQUEST_FAILED",
      `Opening archive "${archivePath}" for upload failed: ${describeFailure(error)}`,
    );
  }

  const onProgress = deps?.onProgress;
  let bytesUploaded = 0;

  // Counting wrapper: fetch pulls the archive through it, every chunk advances the cumulative
  // count, and `bytesUploaded` ends at exactly `totalBytes` after the last chunk.
  const body = file.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesUploaded += chunk.byteLength;
        onProgress?.(bytesUploaded, totalBytes);
        controller.enqueue(chunk);
      },
    }),
  );

  const fetchImpl = deps?.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(uploadUrl, { method: "PUT", body });
  } catch (error) {
    throw new SourceTransferError(
      "S3_UPLOAD_REQUEST_FAILED",
      `PUT of archive "${archivePath}" to the presigned URL failed: ${describeFailure(error)}`,
    );
  }

  if (!response.ok) {
    const detail = await readResponseDetail(response);
    const statusLine =
      response.statusText === ""
        ? `HTTP ${response.status}`
        : `HTTP ${response.status} ${response.statusText}`;

    throw new SourceTransferError(
      "S3_UPLOAD_REJECTED",
      `S3 rejected the upload of archive "${archivePath}" with ${statusLine}` +
        (detail === "" ? "" : `: ${detail}`),
    );
  }

  return { uploadedBytes: totalBytes };
};
