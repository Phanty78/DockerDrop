import { describe, expect, it } from "bun:test";

import { InMemoryTransferStore } from "../../../src/backend/transfers/transfers";
import type {
  CreateTransferDeps,
  TransferStore,
} from "../../../src/backend/transfers/transfers.types";
import { postTransfersHandler } from "../../../src/backend/http/transfers.route";

/**
 * Contract under test: `postTransfersHandler(rawBody: string, deps, store): Response`
 * — POST /transfers, task 16.4 (architecture §9.3).
 *
 * 201 with exactly `{ id, status, storage: { upload }, expires_at }` for a valid body,
 * 400 TRANSFER_BODY_INVALID for malformed or invalid JSON,
 * 422 TRANSFER_RECIPIENT_UNKNOWN for a recipient absent from the colleagues configuration.
 * The handler is pure and synchronous: it parses, delegates to `createTransfer` and maps.
 */

/** Frozen deps: the two configured colleagues, a fixed clock and a 1 h retention. */
const DEPS: CreateTransferDeps = {
  users: {
    items: [
      { id: "mael", display_name: "Maël" },
      { id: "thomas", display_name: "Thomas" },
    ],
  },
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

    expect(body).toEqual({
      id: expect.stringMatching(/^tr_/),
      status: "created",
      storage: { upload: "temporary-upload-mechanism" },
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
