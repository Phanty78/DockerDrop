import { describe, expect, it } from "bun:test";

import { InMemoryTransferStore } from "../../../src/backend/transfers/transfers";
import type {
  CreateTransferDeps,
  TransferStore,
} from "../../../src/backend/transfers/transfers.types";
import { postTransfersHandler } from "../../../src/backend/http/transfers.route";

/**
 * Contract under test: `postTransfersHandler(rawBody: string, deps, store): Response`
 * — POST /transfers, tasks 16.4 + 16.5 (architecture §9.3).
 *
 * 201 with exactly `{ id, status, storage: { upload }, expires_at }` for a valid body;
 * `storage.upload` is the temporary descriptor minted by `deps.storage.presignUpload`
 * for the transfer id (task 16.5: the archive binary never transits through the backend),
 * 400 TRANSFER_BODY_INVALID for malformed or invalid JSON — including a raw archive binary
 * payload, 422 TRANSFER_RECIPIENT_UNKNOWN for a recipient absent from the colleagues
 * configuration. The handler is pure and synchronous: it parses, delegates to
 * `createTransfer` and maps.
 */

/**
 * Frozen deps: the two configured colleagues, a fake S3 upload mechanism, a fixed clock
 * and a 1 h retention.
 */
const DEPS: CreateTransferDeps = {
  users: {
    items: [
      { id: "mael", display_name: "Maël" },
      { id: "thomas", display_name: "Thomas" },
    ],
  },
  storage: { presignUpload: (transferId) => `s3://fake-upload/${transferId}` },
  now: () => new Date("2026-09-24T15:30:00.000Z"),
  retentionMs: 3_600_000,
};

/** Shape intentionally loose: the assertions must be able to detect leaked keys. */
interface TransferBody {
  id: string;
  status: string;
  storage: Record<string, unknown>;
  expires_at: string;
}

/** Shape intentionally loose too: only `code` and `message` may be exposed. */
interface TransferErrorBody {
  error: { code: string; message: string };
}

const VALID_RAW_BODY = JSON.stringify({
  recipient_user_id: "thomas",
  source_volume_name: "mysql_client_x",
});

describe("postTransfersHandler", () => {
  it("crée un transfert temporaire : 201, en-tête JSON et corps §9.3", async () => {
    const store = new InMemoryTransferStore();

    const response = postTransfersHandler(VALID_RAW_BODY, DEPS, store);

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as TransferBody;

    // The transfer id is non-deterministic: assert the descriptor against the id
    // actually minted rather than a hard-coded string.
    expect(body.id).toMatch(/^tr_/);
    expect(body).toEqual({
      id: body.id,
      status: "created",
      storage: { upload: `s3://fake-upload/${body.id}` },
      expires_at: "2026-09-24T16:30:00.000Z",
    });
  });

  it("n'expose aucune clé superflue dans la réponse 201", async () => {
    const store = new InMemoryTransferStore();

    const response = postTransfersHandler(VALID_RAW_BODY, DEPS, store);

    expect(response.status).toBe(201);

    const body = (await response.json()) as TransferBody;

    expect(Object.keys(body)).toEqual(["id", "status", "storage", "expires_at"]);
    expect(Object.keys(body.storage)).toEqual(["upload"]);
  });

  it("refuse un corps JSON malformé par un 400 TRANSFER_BODY_INVALID", async () => {
    const store = new InMemoryTransferStore();

    const response = postTransfersHandler("not json", DEPS, store);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as TransferErrorBody;

    expect(body.error.code).toBe("TRANSFER_BODY_INVALID");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.message.length).toBeGreaterThan(0);
    // The error body exposes exactly `error: { code, message }`, nothing technical.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error)).toEqual(["code", "message"]);
    // A refused request leaves no temporary state behind.
    expect(store.list()).toEqual([]);
  });

  it("refuse le binaire de l'archive comme payload de transfert", async () => {
    const store = new InMemoryTransferStore();
    // A raw archive binary (NUL bytes + non-UTF-8 tail) is not valid JSON: it must be
    // refused before any transfer record or S3 descriptor exists (§16.5 bullet 5).
    const binaryRawBody = String.fromCharCode(0, 1, 2, 3) + "\u00e9tar\u2026";

    const response = postTransfersHandler(binaryRawBody, DEPS, store);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as TransferErrorBody;

    expect(body).toEqual({
      error: { code: "TRANSFER_BODY_INVALID", message: expect.any(String) },
    });
    expect(body.error.message.length).toBeGreaterThan(0);
    // The refused binary leaves no temporary state behind.
    expect(store.list()).toEqual([]);
  });

  it("refuse un corps JSON valide mais incomplet par un 400 TRANSFER_BODY_INVALID", async () => {
    const store = new InMemoryTransferStore();

    const response = postTransfersHandler(
      JSON.stringify({ recipient_user_id: "thomas" }),
      DEPS,
      store,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as TransferErrorBody;

    expect(body).toEqual({
      error: { code: "TRANSFER_BODY_INVALID", message: expect.any(String) },
    });
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(store.list()).toEqual([]);
  });

  it("refuse un destinataire inconnu par un 422 TRANSFER_RECIPIENT_UNKNOWN", async () => {
    const store = new InMemoryTransferStore();

    const response = postTransfersHandler(
      JSON.stringify({ recipient_user_id: "inconnu", source_volume_name: "mysql_client_x" }),
      DEPS,
      store,
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as TransferErrorBody;

    expect(body).toEqual({
      error: { code: "TRANSFER_RECIPIENT_UNKNOWN", message: expect.any(String) },
    });
    expect(body.error.message.length).toBeGreaterThan(0);
    // The shared store must stay empty: an unknown recipient creates no temporary transfer.
    expect(store.list()).toEqual([]);
  });

  it("laisse remonter une erreur inattendue qui n'est pas une TransferError", () => {
    const store: TransferStore = {
      add() {
        throw new Error("boom-sentinel");
      },
      get() {
        return null;
      },
      list() {
        return [];
      },
    };

    // Unexpected failures must not be converted into a 4xx/5xx JSON response.
    expect(() => postTransfersHandler(VALID_RAW_BODY, DEPS, store)).toThrow("boom-sentinel");
  });
});
