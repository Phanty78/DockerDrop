import { describe, expect, it } from "bun:test";

import { createTransfer, InMemoryTransferStore } from "../../../src/backend/transfers/transfers";
import {
  DEFAULT_RETENTION_MS,
  DEFAULT_UPLOAD_DESCRIPTOR,
  TransferError,
} from "../../../src/backend/transfers/transfers.types";
import type {
  CreateTransferDeps,
  TransferRecord,
} from "../../../src/backend/transfers/transfers.types";

/**
 * Contract under test (task 16.4, architecture §9.3):
 * `createTransfer(parsedBody, deps, store)` validates a parsed POST /transfers body,
 * refuses an unknown recipient, builds an in-memory `TransferRecord` and returns
 * exactly `{ id, status: "created", storage: { upload }, expires_at }`.
 * No state is persisted: the store is the only state, and it is plain in-memory.
 */

const knownConfig: { items: Array<{ id: string; display_name: string }> } = {
  items: [{ id: "thomas", display_name: "Thomas" }],
};

const FIXED_NOW = new Date("2026-09-24T15:30:00.000Z");
const ONE_HOUR_MS = 3_600_000;
const UPLOAD_DESCRIPTOR = "s3://dockerdrop-temporary/upload-descriptor";

const validBody = {
  recipient_user_id: "thomas",
  source_volume_name: "mysql_client_x",
};

/** Runs `run` and returns whatever it threw; fails loudly when it returned normally. */
function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it returned normally.");
}

/** Asserts the captured value is an explicit, loggable `TransferError` with the expected code. */
function expectTransferError(error: unknown, code: TransferError["code"]): TransferError {
  expect(error).toBeInstanceOf(TransferError);
  const transferError = error as TransferError;
  expect(transferError.name).toBe("TransferError");
  expect(transferError.code).toBe(code);
  expect(transferError.message.length).toBeGreaterThan(0);
  return transferError;
}

function deps(overrides: Partial<CreateTransferDeps> = {}): CreateTransferDeps {
  return {
    users: knownConfig,
    now: () => FIXED_NOW,
    retentionMs: ONE_HOUR_MS,
    uploadDescriptor: UPLOAD_DESCRIPTOR,
    ...overrides,
  };
}

describe("InMemoryTransferStore", () => {
  it("conserve l'ordre d'insertion et renvoie null pour un identifiant inconnu", () => {
    const store = new InMemoryTransferStore();
    const first = makeRecord("tr_first", "2026-09-24T15:30:00.000Z");
    const second = makeRecord("tr_second", "2026-09-24T15:31:00.000Z");

    expect(store.list()).toEqual([]);
    expect(store.get("tr_first")).toBeNull();

    store.add(first);
    store.add(second);

    expect(store.get("tr_first")).toEqual(first);
    expect(store.get("tr_unknown")).toBeNull();
    expect(store.list()).toEqual([first, second]);
  });

  it("remplace un enregistrement de même identifiant", () => {
    const store = new InMemoryTransferStore();
    const initial = makeRecord("tr_same", "2026-09-24T15:30:00.000Z");
    const replacement = makeRecord("tr_same", "2026-09-24T16:30:00.000Z");

    store.add(initial);
    store.add(replacement);

    expect(store.get("tr_same")).toEqual(replacement);
    expect(store.list()).toEqual([replacement]);
  });
});

describe("createTransfer", () => {
  it("crée un transfert valide : réponse exacte, identifiant unique et expiration calculée", () => {
    const store = new InMemoryTransferStore();

    const response = createTransfer(validBody, deps(), store);

    expect(response.status).toBe("created");
    expect(response.id).toMatch(/^tr_[0-9a-f-]{36}$/);
    expect(response.storage).toEqual({ upload: UPLOAD_DESCRIPTOR });
    expect(response.expires_at).toBe("2026-09-24T16:30:00.000Z");
    expect(response).toEqual({
      id: response.id,
      status: "created",
      storage: { upload: UPLOAD_DESCRIPTOR },
      expires_at: "2026-09-24T16:30:00.000Z",
    });
    // No extra top-level key, no extra `storage` key.
    expect(Object.keys(response).sort()).toEqual(["expires_at", "id", "status", "storage"]);
    expect(Object.keys(response.storage)).toEqual(["upload"]);
  });

  it("produit un identifiant différent à chaque création", () => {
    const store = new InMemoryTransferStore();

    const first = createTransfer(validBody, deps(), store);
    const second = createTransfer(validBody, deps(), store);

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(/^tr_[0-9a-f-]{36}$/);
    expect(second.id).toMatch(/^tr_[0-9a-f-]{36}$/);
    expect(store.list()).toHaveLength(2);
  });

  it("associe le nom du volume source et le destinataire au transfert temporaire", () => {
    const store = new InMemoryTransferStore();

    const response = createTransfer(validBody, deps(), store);
    const record = store.get(response.id);

    expect(record).not.toBeNull();
    const transfer = record as TransferRecord;
    expect(transfer.id).toBe(response.id);
    expect(transfer.recipientUserId).toBe("thomas");
    expect(transfer.sourceVolumeName).toBe("mysql_client_x");
    expect(transfer.status).toBe("created");
    expect(transfer.createdAt).toEqual(FIXED_NOW);
    expect(transfer.expiresAt).toEqual(new Date("2026-09-24T16:30:00.000Z"));
    expect(store.list()).toEqual([transfer]);
  });

  it("refuse un destinataire inconnu et ne stocke rien", () => {
    const store = new InMemoryTransferStore();

    const error = captureThrown(() =>
      createTransfer(
        { recipient_user_id: "inconnu", source_volume_name: "mysql_client_x" },
        deps(),
        store,
      ),
    );

    const transferError = expectTransferError(error, "TRANSFER_RECIPIENT_UNKNOWN");
    // The message names the refused recipient so the refusal is loggable.
    expect(transferError.message).toContain("inconnu");
    expect(store.list()).toEqual([]);
  });

  it("calcule expires_at par défaut avec DEFAULT_RETENTION_MS", () => {
    const store = new InMemoryTransferStore();

    const response = createTransfer(validBody, deps({ retentionMs: undefined }), store);

    const expected = new Date(FIXED_NOW.getTime() + DEFAULT_RETENTION_MS);
    expect(response.expires_at).toBe(expected.toISOString());
    expect(response.expires_at).toBe("2026-09-25T15:30:00.000Z");
    expect(store.get(response.id)?.expiresAt).toEqual(expected);
  });

  it("utilise le descripteur d'upload par défaut quand aucun n'est fourni", () => {
    const store = new InMemoryTransferStore();

    const response = createTransfer(validBody, deps({ uploadDescriptor: undefined }), store);

    expect(response.storage).toEqual({ upload: DEFAULT_UPLOAD_DESCRIPTOR });
  });

  it("nettoie les espaces autour du destinataire et du nom de volume", () => {
    const store = new InMemoryTransferStore();

    const response = createTransfer(
      { recipient_user_id: " thomas ", source_volume_name: " mysql_client_x " },
      deps(),
      store,
    );

    expect(response.status).toBe("created");
    const transfer = store.get(response.id) as TransferRecord;
    expect(transfer.recipientUserId).toBe("thomas");
    expect(transfer.sourceVolumeName).toBe("mysql_client_x");
  });

  it("fonctionne sans aucun état persistant préalable", () => {
    const store = new InMemoryTransferStore();

    expect(store.list()).toEqual([]);

    const response = createTransfer(validBody, deps(), store);

    expect(response.status).toBe("created");
    expect(store.list()).toHaveLength(1);
  });

  const invalidBodies: Array<{ label: string; body: unknown }> = [
    { label: "une chaîne", body: JSON.stringify(validBody) },
    { label: "un tableau", body: ["thomas", "mysql_client_x"] },
    { label: "null", body: null },
    { label: "undefined", body: undefined },
    { label: "un objet vide", body: {} },
    { label: "recipient_user_id absent", body: { source_volume_name: "mysql_client_x" } },
    { label: "source_volume_name absent", body: { recipient_user_id: "thomas" } },
    {
      label: "recipient_user_id non-chaîne",
      body: { recipient_user_id: 42, source_volume_name: "mysql_client_x" },
    },
    {
      label: "source_volume_name non-chaîne",
      body: { recipient_user_id: "thomas", source_volume_name: { name: "mysql_client_x" } },
    },
    {
      label: "recipient_user_id blanc",
      body: { recipient_user_id: "   ", source_volume_name: "mysql_client_x" },
    },
    {
      label: "source_volume_name blanc",
      body: { recipient_user_id: "thomas", source_volume_name: "\t\n " },
    },
  ];

  for (const { label, body } of invalidBodies) {
    it(`rejette un corps invalide (${label}) sans rien stocker`, () => {
      const store = new InMemoryTransferStore();

      const error = captureThrown(() => createTransfer(body, deps(), store));

      expectTransferError(error, "TRANSFER_BODY_INVALID");
      expect(store.list()).toEqual([]);
    });
  }

  it("nomme le champ fautif dans le message d'erreur", () => {
    const store = new InMemoryTransferStore();

    const error = captureThrown(() =>
      createTransfer({ source_volume_name: "mysql_client_x" }, deps(), store),
    );

    const transferError = expectTransferError(error, "TRANSFER_BODY_INVALID");
    expect(transferError.message).toContain("recipient_user_id");
  });
});

/** Builds a `TransferRecord` for the store-only tests. */
function makeRecord(id: string, createdAtIso: string): TransferRecord {
  const createdAt = new Date(createdAtIso);
  return {
    id,
    recipientUserId: "thomas",
    sourceVolumeName: "mysql_client_x",
    status: "created",
    createdAt,
    expiresAt: new Date(createdAt.getTime() + ONE_HOUR_MS),
  };
}
