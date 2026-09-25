/**
 * Central backend entrypoint — tasks 16.1 + 16.4 + 16.5 + 16.6 wiring.
 * Serves `GET /users` from the colleagues configuration file and
 * `POST /transfers` creating temporary transfers, and applies the §8 state machine
 * through `PATCH /transfers/{transferId}` (in-memory state only).
 *
 * Configuration:
 * - `USERS_CONFIG_PATH`: path to users.json (default: `data/users.json`).
 * - `PORT`: listen port (default: 8787).
 * - `TRANSFER_RETENTION_MS`: retention used to compute `expires_at`
 *   (default: 24 h — see DEFAULT_RETENTION_MS).
 * - `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
 *   `S3_SECRET_ACCESS_KEY`: S3 configuration of the temporary upload mechanism
 *   (task 16.5); all five are required — any missing variable aborts boot.
 *
 * Binds to 127.0.0.1 by default; a wider interface must be validated explicitly.
 */
import { loadUsersConfig } from "./config/users";
import { getUsersHandler } from "./http/users.route";
import { patchTransfersHandler, postTransfersHandler } from "./http/transfers.route";
import { InMemoryTransferStore } from "./transfers/transfers";
import { DEFAULT_RETENTION_MS } from "./transfers/transfers.types";
import type { TransferReadyNotifier } from "./transfers/transfers.types";
import { UsersConfigError } from "./config/users.types";
import { createSigV4UploadMechanism, loadS3Config } from "./storage/s3";
import type { S3PresignConfig } from "./storage/s3.types";
import { S3ConfigError } from "./storage/s3.types";

const configPath = process.env.USERS_CONFIG_PATH ?? "data/users.json";
const port = Number(process.env.PORT ?? 8787);
const retentionMs = process.env.TRANSFER_RETENTION_MS
  ? Number(process.env.TRANSFER_RETENTION_MS)
  : DEFAULT_RETENTION_MS;
if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
  console.error(
    `[server] invalid TRANSFER_RETENTION_MS: ${JSON.stringify(process.env.TRANSFER_RETENTION_MS)} ` +
      `(expected a positive number of milliseconds, default ${DEFAULT_RETENTION_MS})`,
  );
  process.exit(1);
}

let s3Config: S3PresignConfig;
try {
  s3Config = loadS3Config(process.env);
} catch (error) {
  if (error instanceof S3ConfigError) {
    console.error(`[s3-config] ${error.code}: ${error.message}`);
  } else {
    console.error("[s3-config] unexpected failure:", error);
  }
  process.exit(1);
}

/**
 * Temporary upload descriptor factory (§16.5): it only ever signs the transfer's single
 * S3 object — the archive binary itself never transits through this process.
 */
const storage = createSigV4UploadMechanism(s3Config);

const config = await loadUsersConfig(configPath).catch((error: unknown) => {
  if (error instanceof UsersConfigError) {
    console.error(
      `[users-config] ${error.code}: ${error.message} (path=${error.path})`,
    );
  } else {
    console.error("[users-config] unexpected failure:", error);
  }
  process.exit(1);
});

/** Temporary transfer state: in-memory only, the MVP imposes no persistent table (§16.4). */
const transferStore = new InMemoryTransferStore();

/**
 * Ready port of §8/§16.6: one loggable line per valid transition to "ready", carrying the
 * committed record. The Google Chat webhook lands behind this same port in task 16.8.
 */
const notifier: TransferReadyNotifier = {
  notifyReady(record) {
    console.log(`[transfer-ready] id=${record.id} volume=${record.sourceVolumeName} recipient=${record.recipientUserId} expires_at=${record.expiresAt.toISOString()}`);
  },
};

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/users") {
      return getUsersHandler(config);
    }
    if (request.method === "POST" && url.pathname === "/transfers") {
      return postTransfersHandler(
        await request.text(),
        { users: config, storage, retentionMs },
        transferStore,
      );
    }
    if (request.method === "PATCH" && url.pathname.startsWith("/transfers/")) {
      // The id is a path segment, percent-decoded (any other decoding is the client's).
      let transferId: string;
      try {
        transferId = decodeURIComponent(url.pathname.slice("/transfers/".length));
      } catch {
        // Deliberate choice: a malformed request-target names no transfer, so it answers
        // the plain 404 exactly like the blank-id case below, not the JSON
        // TRANSFER_NOT_FOUND a well-formed unknown id yields. RFC 9110 would justify a
        // 400 here; 404 is kept for consistency with the local-only MVP, and the
        // 405-vs-404 nuances are deferred.
        return new Response("Not Found", { status: 404 });
      }
      // A blank id is not a transfer id: fall through to the 404 below.
      if (transferId.trim().length > 0) {
        return patchTransfersHandler(
          await request.text(),
          transferId,
          { notifier },
          transferStore,
        );
      }
    }
    return new Response("Not Found", { status: 404 });
  },
  // Unexpected failures must never serve Bun's dev error page (stack, source, cwd):
  // log server-side and answer an opaque 500.
  error(error) {
    console.error("[server] unexpected failure:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log(`DockerDrop backend listening on http://127.0.0.1:${port}`);
