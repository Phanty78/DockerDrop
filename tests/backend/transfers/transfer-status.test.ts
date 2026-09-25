import { describe, expect, it } from "bun:test";

import {
  applyTransferStatus,
  InMemoryTransferStore,
} from "../../../src/backend/transfers/transfers";
import { TransferError } from "../../../src/backend/transfers/transfers.types";
import type {
  ApplyTransferStatusDeps,
  TransferReadyNotifier,
  TransferRecord,
  TransferStatus,
} from "../../../src/backend/transfers/transfers.types";

/**
 * Contract under test (task 16.6, architecture §8/§9.4):
 * `applyTransferStatus(transferId, parsedBody, store, deps)` applies the centralized
 * `TRANSFER_TRANSITIONS` state machine to an existing in-memory transfer: the body must
 * carry a non-blank string `status` naming one of the eight statuses; the record must
 * exist and be non-terminal; the current→target pair must be allowed; an elapsed
 * retention window only still accepts "expired"; the optional `archive_size` must be a
 * non-negative integer; the updated record replaces the previous one via `store.update`;
 * and a valid transition to "ready" fires `deps.notifier` exactly once, with the
 * committed record, after the commit — never for any other status nor on an error path.
 */

const FIXED_NOW = new Date("2026-09-24T15:30:00.000Z");
const ONE_HOUR_MS = 3_600_000;
const FIXED_EXPIRES_AT = "2026-09-24T16:30:00.000Z";

/** Builds a `TransferRecord` for the state-machine tests; `expiresAt` defaults to now + 1 h. */
function makeRecord(
  id: string,
  status: TransferStatus,
  overrides: Partial<TransferRecord> = {},
): TransferRecord {
  return {
    id,
    recipientUserId: "thomas",
    sourceVolumeName: "mysql_client_x",
    status,
    createdAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + ONE_HOUR_MS),
    ...overrides,
  };
}

/** Seeds an `InMemoryTransferStore` with the given records, in order. */
function storeWith(...records: readonly TransferRecord[]): InMemoryTransferStore {
  const store = new InMemoryTransferStore();
  for (const record of records) store.add(record);
  return store;
}

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

/** Deps frozen on FIXED_NOW so retention never drifts with the real clock. */
function deps(overrides: Partial<ApplyTransferStatusDeps> = {}): ApplyTransferStatusDeps {
  return { now: () => FIXED_NOW, ...overrides };
}

/** Counting notifier: collects every record it is handed, in call order. */
function recordingNotifier(): {
  notifier: TransferReadyNotifier;
  readyRecords: TransferRecord[];
} {
  const readyRecords: TransferRecord[] = [];
  return {
    notifier: { notifyReady: (record) => readyRecords.push(record) },
    readyRecords,
  };
}

describe("InMemoryTransferStore.update", () => {
  it("remplace l'enregistrement de même identifiant", () => {
    const store = new InMemoryTransferStore();
    const initial = makeRecord("tr_same", "created");
    const replacement = makeRecord("tr_same", "preparing");

    store.add(initial);
    store.update(replacement);

    expect(store.get("tr_same")).toEqual(replacement);
    expect(store.get("tr_same")?.status).toBe("preparing");
    expect(store.list()).toEqual([replacement]);
  });
});

describe("applyTransferStatus", () => {
  it("applique les transitions valides de created jusqu'à completed", () => {
    const store = storeWith(makeRecord("tr_chain", "created"));
    const expectedStatuses: readonly TransferStatus[] = [
      "preparing",
      "uploading",
      "ready",
      "downloading",
      "completed",
    ];

    const responses = expectedStatuses.map((status) =>
      applyTransferStatus("tr_chain", { status }, store, deps()),
    );

    expect(responses).toEqual(
      expectedStatuses.map((status) => ({
        id: "tr_chain",
        status,
        expires_at: FIXED_EXPIRES_AT,
      })),
    );
    expect(store.get("tr_chain")).toEqual(makeRecord("tr_chain", "completed"));
  });

  it("refuse les sauts incohérents (created → ready, created → completed)", () => {
    const store = storeWith(makeRecord("tr_jump", "created"));

    for (const status of ["ready", "completed"] as const) {
      const error = captureThrown(() =>
        applyTransferStatus("tr_jump", { status }, store, deps()),
      );

      const transferError = expectTransferError(error, "TRANSFER_TRANSITION_INVALID");
      // The message names both the current status and the refused target (loggable refusal).
      expect(transferError.message).toContain("created");
      expect(transferError.message).toContain(status);
    }

    expect(store.get("tr_jump")).toEqual(makeRecord("tr_jump", "created"));
  });

  it("refuse les retours en arrière (uploading → preparing, ready → uploading)", () => {
    const uploading = makeRecord("tr_back_1", "uploading");
    const ready = makeRecord("tr_back_2", "ready");
    const store = storeWith(uploading, ready);

    const first = captureThrown(() =>
      applyTransferStatus("tr_back_1", { status: "preparing" }, store, deps()),
    );
    const second = captureThrown(() =>
      applyTransferStatus("tr_back_2", { status: "uploading" }, store, deps()),
    );

    expectTransferError(first, "TRANSFER_TRANSITION_INVALID");
    expectTransferError(second, "TRANSFER_TRANSITION_INVALID");
    expect(store.list()).toEqual([uploading, ready]);
  });

  it("accepte failed depuis un état actif (uploading → failed, ready → failed)", () => {
    const store = storeWith(
      makeRecord("tr_fail_1", "uploading"),
      makeRecord("tr_fail_2", "ready"),
    );

    const first = applyTransferStatus("tr_fail_1", { status: "failed" }, store, deps());
    const second = applyTransferStatus("tr_fail_2", { status: "failed" }, store, deps());

    expect(first).toEqual({ id: "tr_fail_1", status: "failed", expires_at: FIXED_EXPIRES_AT });
    expect(second).toEqual({ id: "tr_fail_2", status: "failed", expires_at: FIXED_EXPIRES_AT });
    expect(store.get("tr_fail_1")?.status).toBe("failed");
    expect(store.get("tr_fail_2")?.status).toBe("failed");
  });

  it("représente l'expiration forcée (created → expired)", () => {
    const store = storeWith(makeRecord("tr_expire", "created"));

    const response = applyTransferStatus("tr_expire", { status: "expired" }, store, deps());

    expect(response).toEqual({ id: "tr_expire", status: "expired", expires_at: FIXED_EXPIRES_AT });
    expect(store.get("tr_expire")?.status).toBe("expired");
  });

  it("refuse toute transition depuis un statut terminal (completed, failed, expired)", () => {
    const completed = makeRecord("tr_terminal_1", "completed");
    const failed = makeRecord("tr_terminal_2", "failed");
    const expired = makeRecord("tr_terminal_3", "expired");
    const store = storeWith(completed, failed, expired);

    const attempts: ReadonlyArray<{ id: string; status: TransferStatus }> = [
      { id: "tr_terminal_1", status: "failed" },
      { id: "tr_terminal_2", status: "preparing" },
      { id: "tr_terminal_3", status: "ready" },
    ];

    for (const { id, status } of attempts) {
      const error = captureThrown(() => applyTransferStatus(id, { status }, store, deps()));

      const transferError = expectTransferError(error, "TRANSFER_TRANSITION_INVALID");
      expect(transferError.message).toContain(id);
    }

    expect(store.list()).toEqual([completed, failed, expired]);
  });

  it("refuse un statut inconnu (\"shipped\") en nommant la valeur reçue", () => {
    const store = storeWith(makeRecord("tr_unknown_status", "created"));

    const error = captureThrown(() =>
      applyTransferStatus("tr_unknown_status", { status: "shipped" }, store, deps()),
    );

    const transferError = expectTransferError(error, "TRANSFER_STATUS_UNKNOWN");
    expect(transferError.message).toContain("shipped");
    // The status is validated before the record is looked up: an unknown status on an
    // unknown transfer is still reported as an unknown status.
    const unknownIdError = captureThrown(() =>
      applyTransferStatus("tr_ghost_id", { status: "shipped" }, store, deps()),
    );
    expectTransferError(unknownIdError, "TRANSFER_STATUS_UNKNOWN");
    expect(store.get("tr_unknown_status")).toEqual(makeRecord("tr_unknown_status", "created"));
  });

  it("refuse un transfert inconnu en nommant l'identifiant", () => {
    const store = storeWith();

    const error = captureThrown(() =>
      applyTransferStatus("tr_ghost", { status: "preparing" }, store, deps()),
    );

    const transferError = expectTransferError(error, "TRANSFER_NOT_FOUND");
    expect(transferError.message).toContain("tr_ghost");
    expect(store.list()).toEqual([]);
  });

  const nonObjectBodies: ReadonlyArray<{ label: string; body: unknown; detail: string }> = [
    { label: "une chaîne", body: "ready", detail: "a string" },
    { label: "un tableau", body: ["ready"], detail: "an array" },
    { label: "null", body: null, detail: "null" },
    { label: "undefined", body: undefined, detail: "undefined" },
  ];

  for (const { label, body, detail } of nonObjectBodies) {
    it(`refuse un corps qui n'est pas un objet (${label}) sans modifier le transfert`, () => {
      const store = storeWith(makeRecord("tr_body", "created"));

      const error = captureThrown(() =>
        applyTransferStatus("tr_body", body, store, deps()),
      );

      const transferError = expectTransferError(error, "TRANSFER_BODY_INVALID");
      // The message names what was received so the refusal is loggable.
      expect(transferError.message).toContain(detail);
      expect(store.get("tr_body")).toEqual(makeRecord("tr_body", "created"));
    });
  }

  it("refuse un champ status absent, non-chaîne ou blanc en nommant le champ", () => {
    const store = storeWith(makeRecord("tr_body_field", "created"));

    for (const body of [{}, { archive_size: 12 }, { status: 42 }, { status: "   " }]) {
      const error = captureThrown(() =>
        applyTransferStatus("tr_body_field", body, store, deps()),
      );

      const transferError = expectTransferError(error, "TRANSFER_BODY_INVALID");
      expect(transferError.message).toContain("status");
    }

    expect(store.get("tr_body_field")).toEqual(makeRecord("tr_body_field", "created"));
  });

  it("nettoie les espaces autour du statut", () => {
    const store = storeWith(makeRecord("tr_trim", "uploading"));

    const response = applyTransferStatus("tr_trim", { status: " ready " }, store, deps());

    expect(response).toEqual({ id: "tr_trim", status: "ready", expires_at: FIXED_EXPIRES_AT });
    expect(store.get("tr_trim")?.status).toBe("ready");
  });

  it("n'accepte que expired une fois la rétention écoulée", () => {
    const elapsed = makeRecord("tr_elapsed", "uploading", {
      expiresAt: new Date(FIXED_NOW.getTime() - 1),
    });
    // Boundary case: now === expiresAt is already elapsed.
    const atBoundary = makeRecord("tr_boundary", "created", {
      expiresAt: new Date(FIXED_NOW.getTime()),
    });
    const store = storeWith(elapsed, atBoundary);

    // "failed" or a valid lifecycle successor would otherwise be allowed, but an
    // elapsed transfer may only ever become "expired".
    const refused: readonly TransferStatus[] = [
      "preparing",
      "uploading",
      "ready",
      "failed",
      "completed",
    ];
    for (const record of [elapsed, atBoundary]) {
      for (const status of refused) {
        const error = captureThrown(() =>
          applyTransferStatus(record.id, { status }, store, deps()),
        );

        const transferError = expectTransferError(error, "TRANSFER_EXPIRED");
        expect(transferError.message).toContain(record.id);
      }
    }
    expect(store.list()).toEqual([elapsed, atBoundary]);

    const response = applyTransferStatus("tr_elapsed", { status: "expired" }, store, deps());
    expect(response).toEqual({
      id: "tr_elapsed",
      status: "expired",
      expires_at: elapsed.expiresAt.toISOString(),
    });
    expect(store.get("tr_elapsed")?.status).toBe("expired");
  });

  it("accepte, stocke et renvoie archive_size lors du passage à ready", () => {
    const store = storeWith(makeRecord("tr_size", "uploading"));

    const response = applyTransferStatus(
      "tr_size",
      { status: "ready", archive_size: 408021221 },
      store,
      deps(),
    );

    expect(response).toEqual({
      id: "tr_size",
      status: "ready",
      archive_size: 408021221,
      expires_at: FIXED_EXPIRES_AT,
    });
    expect(Object.keys(response).sort()).toEqual([
      "archive_size",
      "expires_at",
      "id",
      "status",
    ]);
    expect(store.get("tr_size")?.archiveSize).toBe(408021221);
  });

  it("accepte un archive_size nul", () => {
    const store = storeWith(makeRecord("tr_size_zero", "uploading"));

    const response = applyTransferStatus(
      "tr_size_zero",
      { status: "ready", archive_size: 0 },
      store,
      deps(),
    );

    expect(response.archive_size).toBe(0);
    expect(store.get("tr_size_zero")?.archiveSize).toBe(0);
  });

  it("n'expose archive_size qu'une fois connu", () => {
    const store = storeWith(makeRecord("tr_nosize", "created"));

    const response = applyTransferStatus("tr_nosize", { status: "preparing" }, store, deps());

    expect(response).toEqual({ id: "tr_nosize", status: "preparing", expires_at: FIXED_EXPIRES_AT });
    expect(Object.keys(response).sort()).toEqual(["expires_at", "id", "status"]);
    expect(Object.hasOwn(store.get("tr_nosize") as TransferRecord, "archiveSize")).toBe(false);
  });

  it("conserve archive_size quand une transition ultérieure ne le répète pas", () => {
    const store = storeWith(makeRecord("tr_keep", "ready", { archiveSize: 408021221 }));

    const response = applyTransferStatus("tr_keep", { status: "downloading" }, store, deps());

    expect(response.archive_size).toBe(408021221);
    expect(store.get("tr_keep")?.archiveSize).toBe(408021221);
    expect(store.get("tr_keep")?.status).toBe("downloading");
  });

  const invalidArchiveSizes: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: "-1", value: -1 },
    { label: "1.5", value: 1.5 },
    { label: "\"big\"", value: "big" },
    { label: "NaN", value: Number.NaN },
    { label: "null", value: null },
  ];

  for (const { label, value } of invalidArchiveSizes) {
    it(`refuse un archive_size invalide (${label}) sans modifier le transfert`, () => {
      const store = storeWith(makeRecord("tr_bad_size", "uploading"));

      const error = captureThrown(() =>
        applyTransferStatus("tr_bad_size", { status: "ready", archive_size: value }, store, deps()),
      );

      const transferError = expectTransferError(error, "TRANSFER_BODY_INVALID");
      expect(transferError.message).toContain("archive_size");
      expect(store.get("tr_bad_size")).toEqual(makeRecord("tr_bad_size", "uploading"));
    });
  }

  it("notifie uniquement au passage valide à ready", () => {
    const { notifier, readyRecords } = recordingNotifier();
    const store = storeWith(makeRecord("tr_notify", "created"));
    const depsWithNotifier = deps({ notifier });

    applyTransferStatus("tr_notify", { status: "preparing" }, store, depsWithNotifier);
    applyTransferStatus("tr_notify", { status: "uploading" }, store, depsWithNotifier);
    expect(readyRecords).toEqual([]);

    // Refused transition: "completed" is not reachable from "uploading" — no notification.
    const refused = captureThrown(() =>
      applyTransferStatus("tr_notify", { status: "completed" }, store, depsWithNotifier),
    );
    expectTransferError(refused, "TRANSFER_TRANSITION_INVALID");

    // Unknown transfer and invalid body paths never notify either.
    captureThrown(() =>
      applyTransferStatus("tr_ghost", { status: "ready" }, store, depsWithNotifier),
    );
    captureThrown(() => applyTransferStatus("tr_notify", "ready", store, depsWithNotifier));
    expect(readyRecords).toEqual([]);

    const ready = applyTransferStatus(
      "tr_notify",
      { status: "ready", archive_size: 408021221 },
      store,
      depsWithNotifier,
    );

    expect(ready.status).toBe("ready");
    expect(readyRecords).toHaveLength(1);
    // The notifier carries the committed record, archive size included.
    expect(readyRecords[0]).toEqual(store.get("tr_notify") as TransferRecord);
    expect(readyRecords[0]?.status).toBe("ready");
    expect(readyRecords[0]?.archiveSize).toBe(408021221);

    // Leaving "ready" never notifies again.
    applyTransferStatus("tr_notify", { status: "downloading" }, store, depsWithNotifier);
    applyTransferStatus("tr_notify", { status: "completed" }, store, depsWithNotifier);
    expect(readyRecords).toHaveLength(1);
  });

  it("commite via store.update sans muter l'enregistrement précédent", () => {
    const seeded = makeRecord("tr_update", "preparing");
    const store = storeWith(seeded);

    const response = applyTransferStatus("tr_update", { status: "uploading" }, store, deps());

    const updated = store.get("tr_update") as TransferRecord;
    expect(updated.status).toBe("uploading");
    // Identity fields are carried over untouched.
    expect(updated.id).toBe(seeded.id);
    expect(updated.recipientUserId).toBe(seeded.recipientUserId);
    expect(updated.sourceVolumeName).toBe(seeded.sourceVolumeName);
    expect(updated.createdAt).toEqual(seeded.createdAt);
    expect(updated.expiresAt).toEqual(seeded.expiresAt);
    expect(store.list()).toEqual([updated]);
    expect(response).toEqual({ id: "tr_update", status: "uploading", expires_at: FIXED_EXPIRES_AT });
    // The previous record is replaced, not mutated in place.
    expect(seeded.status).toBe("preparing");
  });
});
