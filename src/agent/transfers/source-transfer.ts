/**
 * Task 16.7 — orchestrates one source transfer (architecture §6 steps 3–5, §16.7).
 *
 * The source agent drives a single transfer through the frozen ports, and the archive takes the
 * short path: it is built locally (§6 step 3) and PUT straight to the temporary presigned URL of
 * `storage.upload` (§6 step 4) — the binary goes to S3 only, never through the backend. The
 * backend just sees small JSON: `POST /transfers` mints the id and the URL, and the §9.4 status
 * changes report `preparing` (while the archive is being built), `uploading` (while it goes up),
 * then `ready` with the exact archive size — only after a successful upload (§16.7: no false
 * success, no ready notification before the archive is actually in S3).
 *
 * Every failure from the first status change on reports `failed` (best effort, its own errors
 * swallowed) and rethrows the original error unmasked: a `SourceTransferError` from the client or
 * the uploader, a `VolumeArchiveError` from the archive step. There is no resume state and no
 * partial-transfer bookkeeping: a manual relaunch simply calls `runSourceTransfer` again with a
 * fresh request (§16.7 bullet 5).
 */

import { createVolumeArchive } from "../docker/archive";
import type { RunSourceTransfer } from "./source-transfer.types";
import { uploadArchiveToS3 } from "./upload";

export const runSourceTransfer: RunSourceTransfer = async (request, deps) => {
  // §6 step 3: the backend mints the transfer id and the temporary upload URL. Without an id there
  // is nothing to report on, so a creation failure crosses untouched.
  const created = await deps.client.createTransfer({
    recipientUserId: request.recipientUserId,
    volumeName: request.volumeName,
  });

  /**
   * Best-effort §9.4 failure report: the error being propagated is the one that matters, so a
   * refused `failed` PATCH never masks it.
   */
  const reportFailed = async (): Promise<void> => {
    try {
      await deps.client.updateStatus(created.id, "failed");
    } catch {
      // The original failure is already the report; this cleanup carries no extra information.
    }
  };

  try {
    // The status change goes up while preparation starts, not once it finished.
    deps.onProgress?.({ phase: "preparing" });
    await deps.client.updateStatus(created.id, "preparing");

    const archive = await createVolumeArchive(
      { volumeName: request.volumeName, outputPath: request.outputPath },
      { tarSource: deps.tarSource },
    );

    deps.onProgress?.({ phase: "uploading", bytesUploaded: 0, totalBytes: archive.archiveSize });
    await deps.client.updateStatus(created.id, "uploading");

    // §6 step 4: the archive streams straight to S3; only its progress crosses back through here.
    const upload = deps.upload ?? uploadArchiveToS3;
    const uploaded = await upload(archive.archivePath, created.uploadUrl, {
      onProgress: (bytesUploaded, totalBytes) =>
        deps.onProgress?.({ phase: "uploading", bytesUploaded, totalBytes }),
    });

    // §16.7: `ready` (with the exact archive size) is only sent once S3 confirmed the upload.
    await deps.client.updateStatus(created.id, "ready", archive.archiveSize);

    return {
      transferId: created.id,
      archivePath: archive.archivePath,
      archiveSize: archive.archiveSize,
      uploadedBytes: uploaded.uploadedBytes,
    };
  } catch (error) {
    await reportFailed();
    throw error;
  }
};
