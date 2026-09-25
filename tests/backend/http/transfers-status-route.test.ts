import { describe, expect, it } from "bun:test";

import { InMemoryTransferStore } from "../../../src/backend/transfers/transfers";
import type {
  ApplyTransferStatusDeps,
  TransferReadyNotifier,
  TransferRecord,
  TransferStatus,
  TransferStore,
} from "../../../src/backend/transfers/transfers.types";
import { patchTransfersHandler } from "../../../src/backend/http/transfers.route";

/**
 * Contract under test: `patchTransfersHandler(rawBody, transferId, deps, store): Response`
 * — PATCH /transfers/{transferId}, task 16.6 (architecture §9.4), applying the §8 state
 * machine through `applyTransferStatus`.
 *
 * 200 with exactly `{ id, status, archive_size?, expires_at }` for a transition the state
 * machine allows; `{ error: { code, message } }` otherwise — 400 TRANSFER_BODY_INVALID for
 * a body that is not JSON, 400 TRANSFER_STATUS_UNKNOWN for an unknown status, 404
 * TRANSFER_NOT_FOUND for an unknown id, 409 TRANSFER_TRANSITION_INVALID for a forbidden
 * pair, 409 TRANSFER_EXPIRED for a transfer whose retention window elapsed. Every response
 * carries the JSON content type. The handler is synchronous: it parses, delegates to
 * `applyTransferStatus` and maps; only the in-memory store is mutated.
 */

/** Frozen clock: the real clock must never decide whether a seeded record is expired. */
const FIXED_NOW = new Date("2026-09-25T10:00:00.000Z");
const RETENTION_MS = 3_600_000;

/** Default deps: the frozen clock, no notifier (the ready port is exercised separately). */
const DEPS: ApplyTransferStatusDeps = { now: () => FIXED_NOW };

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Seeds a store exactly as task 16.4 would have: `created`, future `expiresAt`, and only
 * the fields of the frozen `TransferRecord`.
 */
function makeRecord(
  id: string,
  overrides: Partial<TransferRecord> = {},
): TransferRecord {
  return {
    id,
    recipientUserId: "thomas",
    sourceVolumeName: "mysql_client_x",
    status: "created",
    createdAt: FIXED_NOW,
    expiresAt: new Date(FIXED_NOW.getTime() + RETENTION_MS),
    ...overrides,
  };
}

/** Shape intentionally loose: the assertions must be able to detect leaked keys. */
interface StatusBody {
  id: string;
  status: string;
  archive_size?: number;
  expires_at: string;
}

/** Shape intentionally loose too: only `code` and `message` may be exposed. */
interface TransferErrorBody {
  error: { code: string; message: string };
}

/**
 * Ready-only port (§16.6): records each call together with the status the store held at
 * call time, so the test can prove the notifier never fires before the commit.
 */
class FakeReadyNotifier implements TransferReadyNotifier {
  readonly notified: TransferRecord[] = [];
  readonly storedStatusAtNotify: (TransferStatus | null)[] = [];

  constructor(private readonly store: TransferStore) {}

  notifyReady(record: TransferRecord): void {
    this.notified.push(record);
    this.storedStatusAtNotify.push(this.store.get(record.id)?.status ?? null);
  }
}

describe("patchTransfersHandler", () => {
  it("applique les transitions via PATCH /transfers/{id}", async () => {
    const store = new InMemoryTransferStore();
    const record = makeRecord("tr_route_preparing");
    store.add(record);

    const response = patchTransfersHandler(
      JSON.stringify({ status: "preparing" }),
      record.id,
      DEPS,
      store,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);

    const body = (await response.json()) as StatusBody;

    expect(body).toEqual({
      id: record.id,
      status: "preparing",
      expires_at: record.expiresAt.toISOString(),
    });
    // No extra key: `archive_size` appears only once the source agent reports it.
    expect(Object.keys(body).sort()).toEqual(["expires_at", "id", "status"]);
    // The state machine committed the new status behind the HTTP surface.
    expect(store.get(record.id)?.status).toBe("preparing");
    expect(store.list()).toHaveLength(1);
  });

  it("retourne 404 pour un transfert inconnu", async () => {
    const store = new InMemoryTransferStore();

    const response = patchTransfersHandler(
      JSON.stringify({ status: "ready" }),
      "tr_absent",
      DEPS,
      store,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);

    const body = (await response.json()) as TransferErrorBody;

    expect(body).toEqual({
      error: { code: "TRANSFER_NOT_FOUND", message: expect.any(String) },
    });
    expect(body.error.message.length).toBeGreaterThan(0);
    // The error body exposes exactly `error: { code, message }`, nothing technical.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error)).toEqual(["code", "message"]);
    expect(store.list()).toEqual([]);
  });

  it("retourne 400 pour un corps non JSON", async () => {
    const store = new InMemoryTransferStore();
    const record = makeRecord("tr_bad_json");
    store.add(record);

    const response = patchTransfersHandler("not json", record.id, DEPS, store);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);

    const body = (await response.json()) as TransferErrorBody;

    expect(body).toEqual({
      error: { code: "TRANSFER_BODY_INVALID", message: expect.any(String) },
    });
    expect(body.error.message.length).toBeGreaterThan(0);
    // A refused body changes nothing.
    expect(store.get(record.id)?.status).toBe("created");
  });

  it("retourne 400 pour un statut inconnu", async () => {
    const store = new InMemoryTransferStore();
    const record = makeRecord("tr_unknown_status");
    store.add(record);

    const response = patchTransfersHandler(
      JSON.stringify({ status: "shipped" }),
      record.id,
      DEPS,
      store,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);

    const body = (await response.json()) as TransferErrorBody;

    expect(body).toEqual({
      error: { code: "TRANSFER_STATUS_UNKNOWN", message: expect.any(String) },
    });
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(store.get(record.id)?.status).toBe("created");
  });

  it("retourne 409 pour une transition interdite", async () => {
    const store = new InMemoryTransferStore();
    const created = makeRecord("tr_jump_ready");
    store.add(created);

    // created → ready skips two lifecycle steps (§8).
    const jump = patchTransfersHandler(
      JSON.stringify({ status: "ready" }),
      created.id,
      DEPS,
      store,
    );

    expect(jump.status).toBe(409);
    expect(jump.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await jump.json()).toEqual({
      error: { code: "TRANSFER_TRANSITION_INVALID", message: expect.any(String) },
    });
    expect(store.get(created.id)?.status).toBe("created");

    // A terminal status never moves again.
    const completed = makeRecord("tr_terminal", { status: "completed" });
    store.add(completed);

    const terminal = patchTransfersHandler(
      JSON.stringify({ status: "downloading" }),
      completed.id,
      DEPS,
      store,
    );

    expect(terminal.status).toBe(409);
    expect(terminal.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await terminal.json()).toEqual({
      error: { code: "TRANSFER_TRANSITION_INVALID", message: expect.any(String) },
    });
    expect(store.get(completed.id)?.status).toBe("completed");
  });

  it("retourne 409 pour un transfert expiré", async () => {
    const store = new InMemoryTransferStore();
    // "uploading" on purpose: would the retention window not have elapsed, this transition
    // would be legal — the refusal can only come from the expiry rule.
    const expired = makeRecord("tr_expired", {
      status: "uploading",
      expiresAt: new Date(FIXED_NOW.getTime() - 1_000),
    });
    store.add(expired);

    const response = patchTransfersHandler(
      JSON.stringify({ status: "ready" }),
      expired.id,
      DEPS,
      store,
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
    expect(await response.json()).toEqual({
      error: { code: "TRANSFER_EXPIRED", message: expect.any(String) },
    });
    expect(store.get(expired.id)?.status).toBe("uploading");
  });

  it("ne peut pas contourner la machine à états", async () => {
    const store = new InMemoryTransferStore();
    const record = makeRecord("tr_chain");
    store.add(record);

    // Direct created → completed: refused, the record stays untouched.
    const direct = patchTransfersHandler(
      JSON.stringify({ status: "completed" }),
      record.id,
      DEPS,
      store,
    );

    expect(direct.status).toBe(409);
    expect(await direct.json()).toEqual({
      error: { code: "TRANSFER_TRANSITION_INVALID", message: expect.any(String) },
    });
    expect(store.get(record.id)?.status).toBe("created");

    // Only the step-by-step §8 chain ever reaches the terminal status.
    const chain: readonly TransferStatus[] = [
      "preparing",
      "uploading",
      "ready",
      "downloading",
      "completed",
    ];
    for (const status of chain) {
      const step = patchTransfersHandler(
        JSON.stringify({ status }),
        record.id,
        DEPS,
        store,
      );

      expect(step.status).toBe(200);
      expect(step.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);
      expect(((await step.json()) as StatusBody).status).toBe(status);
      expect(store.get(record.id)?.status).toBe(status);
    }

    // "completed" is terminal: no way out, not even back to "ready".
    const afterTerminal = patchTransfersHandler(
      JSON.stringify({ status: "ready" }),
      record.id,
      DEPS,
      store,
    );

    expect(afterTerminal.status).toBe(409);
    expect(await afterTerminal.json()).toEqual({
      error: { code: "TRANSFER_TRANSITION_INVALID", message: expect.any(String) },
    });
    expect(store.get(record.id)?.status).toBe("completed");
  });

  it("notifie uniquement au passage valide à ready", async () => {
    const store = new InMemoryTransferStore();
    const record = makeRecord("tr_notify");
    store.add(record);

    const notifier = new FakeReadyNotifier(store);
    const deps: ApplyTransferStatusDeps = { now: () => FIXED_NOW, notifier };

    for (const status of ["preparing", "uploading"] as const) {
      const step = patchTransfersHandler(
        JSON.stringify({ status }),
        record.id,
        deps,
        store,
      );

      expect(step.status).toBe(200);
    }
    // Neither "preparing" nor "uploading" may fire the ready port.
    expect(notifier.notified).toEqual([]);

    const ready = patchTransfersHandler(
      JSON.stringify({ status: "ready" }),
      record.id,
      deps,
      store,
    );

    expect(ready.status).toBe(200);
    expect(notifier.notified).toHaveLength(1);
    // The port carries the committed record: status already persisted when it fires.
    expect(notifier.notified[0]).toEqual(store.get(record.id) as TransferRecord);
    expect(notifier.notified[0]?.status).toBe("ready");
    expect(notifier.storedStatusAtNotify).toEqual(["ready"]);

    // Refused PATCHes (unknown id, forbidden transition) never notify.
    const missing = patchTransfersHandler(
      JSON.stringify({ status: "downloading" }),
      "tr_absent_notify",
      deps,
      store,
    );
    const forbidden = patchTransfersHandler(
      JSON.stringify({ status: "completed" }),
      record.id,
      deps,
      store,
    );

    expect(missing.status).toBe(404);
    expect(forbidden.status).toBe(409);
    expect(notifier.notified).toHaveLength(1);
    expect(notifier.storedStatusAtNotify).toEqual(["ready"]);
  });

  it("conserve archive_size au passage à ready", async () => {
    const store = new InMemoryTransferStore();
    const record = makeRecord("tr_archive_size", { status: "uploading" });
    store.add(record);

    const response = patchTransfersHandler(
      JSON.stringify({ status: "ready", archive_size: 408021221 }),
      record.id,
      DEPS,
      store,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(JSON_CONTENT_TYPE);

    const body = (await response.json()) as StatusBody;

    expect(body).toEqual({
      id: record.id,
      status: "ready",
      archive_size: 408021221,
      expires_at: record.expiresAt.toISOString(),
    });
    expect(Object.keys(body).sort()).toEqual([
      "archive_size",
      "expires_at",
      "id",
      "status",
    ]);
    // The record keeps the reported size: later tasks read it from the store.
    expect(store.get(record.id)?.archiveSize).toBe(408021221);
  });
});
