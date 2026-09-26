import { afterEach, describe, expect, it } from "bun:test";

import { createHttpTransferClient } from "../../../src/agent/transfers/client";
import {
  SourceTransferError,
  type SourceTransferErrorCode,
  type SourceTransferStatus,
} from "../../../src/agent/transfers/source-transfer.types";

/**
 * Contract under test: `createHttpTransferClient` drives the REAL HTTP client against fake
 * backends served by `Bun.serve`. It only ever exchanges small JSON documents with the backend —
 * `POST /transfers` (§9.3) and `PATCH /transfers/{id}` (§9.4) — and maps every refusal (non-2xx,
 * unreadable or incomplete body, transport failure) to an explicit `SourceTransferError`.
 * The archive binary never transits through this client.
 */

/** Wire shape of the `POST /transfers` 201 body, as §9.3 freezes it. */
const CREATED_BODY = {
  id: "tr_fake_1",
  status: "created",
  storage: { upload: "https://s3.fake/tr_fake_1/volume.tar.zst?sig=abc" },
  expires_at: "2026-09-27T10:00:00.000Z",
};

/** One request received by a fake backend, decoded for assertions. */
interface RecordedRequest {
  readonly method: string;
  /** `URL.pathname` as received: percent-encoding preserved, so a double slash stays visible. */
  readonly pathname: string;
  readonly contentType: string | null;
  readonly body: string;
}

/** Fake backend plus the requests it recorded, in arrival order. */
interface FakeBackend {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
}

/** What cleanup needs from a started backend, so tests never name Bun's internal server type. */
interface FakeServer {
  stop(closeActiveConnections?: boolean): void;
}

type FakeResponder = (request: Request, recorded: RecordedRequest) => Response | Promise<Response>;

/** Backends started by the current test; stopped in `afterEach` so no port stays bound. */
let activeServers: FakeServer[] = [];

afterEach(() => {
  for (const server of activeServers) {
    server.stop(true);
  }

  activeServers = [];
});

/** Starts a `Bun.serve` backend on an ephemeral port, recording every request before answering. */
function startFakeBackend(respond: FakeResponder): FakeBackend {
  const requests: RecordedRequest[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.text();
      const recorded: RecordedRequest = {
        method: request.method,
        pathname: new URL(request.url).pathname,
        contentType: request.headers.get("content-type"),
        body,
      };

      requests.push(recorded);

      return respond(request, recorded);
    },
  });

  activeServers.push(server);

  return { baseUrl: `http://127.0.0.1:${server.port}`, requests };
}

/** Backend answering `status`/`body` to everything, for refusal and malformed-body scenarios. */
function startStaticBackend(status: number, body: string): FakeBackend {
  return startFakeBackend(
    () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  );
}

/**
 * Nominal backend: `POST /transfers` returns the §9.3 201 body, `PATCH /transfers/{id}` echoes the
 * received status back with a 200.
 */
function startHappyBackend(): FakeBackend {
  return startFakeBackend((_request, recorded) => {
    if (recorded.method === "POST" && recorded.pathname === "/transfers") {
      return Response.json(CREATED_BODY, { status: 201 });
    }

    if (recorded.method === "PATCH") {
      const { status } = JSON.parse(recorded.body) as { status: SourceTransferStatus };

      return Response.json({
        id: CREATED_BODY.id,
        status,
        expires_at: CREATED_BODY.expires_at,
      });
    }

    return new Response("Not Found", { status: 404 });
  });
}

/** Request at `index`, asserted to exist so `noUncheckedIndexedAccess` stays satisfied. */
function requestAt(backend: FakeBackend, index: number): RecordedRequest {
  const request = backend.requests[index];

  if (request === undefined) {
    throw new Error(`no request recorded at index ${index}`);
  }

  return request;
}

/** Asserts `body` carries exactly `keys`, so no camelCase field leaks onto the wire. */
function expectExactKeys(body: object, keys: readonly string[]): void {
  expect(Object.keys(body).sort()).toEqual([...keys].sort());
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

/** Runs `promise` and asserts it REJECTS with a `SourceTransferError` carrying `code`. */
async function captureTransferError(
  promise: Promise<unknown>,
  code: SourceTransferErrorCode,
): Promise<SourceTransferError> {
  const settlement = await settle(promise);

  // A resolution is a failure here: a refused request must never look like a success.
  expect(settlement.status).toBe("rejected");
  expect(settlement.error).toBeInstanceOf(SourceTransferError);

  const error = settlement.error as SourceTransferError;
  expect(error.name).toBe("SourceTransferError");
  expect(error.code).toBe(code);
  expect(error.message.length).toBeGreaterThan(0);

  return error;
}

describe("createHttpTransferClient", () => {
  it("crée le transfert et expose l'URL d'upload presignée", async () => {
    const backend = startHappyBackend();
    const client = createHttpTransferClient(backend.baseUrl);

    const descriptor = await client.createTransfer({
      recipientUserId: "thomas",
      volumeName: "mysql_client_x",
    });

    expect(descriptor).toEqual({
      id: "tr_fake_1",
      uploadUrl: "https://s3.fake/tr_fake_1/volume.tar.zst?sig=abc",
      expiresAt: "2026-09-27T10:00:00.000Z",
    });
    expectExactKeys(descriptor, ["id", "uploadUrl", "expiresAt"]);

    const request = requestAt(backend, 0);
    expect(backend.requests.length).toBe(1);
    expect(request.method).toBe("POST");
    expect(request.pathname).toBe("/transfers");
    expect(request.contentType).toBe("application/json; charset=utf-8");

    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toEqual({ recipient_user_id: "thomas", source_volume_name: "mysql_client_x" });
    expectExactKeys(body, ["recipient_user_id", "source_volume_name"]);
  });

  it("signale les changements d'état au backend", async () => {
    const backend = startHappyBackend();
    const client = createHttpTransferClient(backend.baseUrl);
    const transferId = "tr_fake/1 x";
    const encodedId = encodeURIComponent(transferId);

    expect(await client.updateStatus(transferId, "preparing")).toBeUndefined();
    expect(await client.updateStatus(transferId, "ready", 408021221)).toBeUndefined();

    expect(backend.requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
      `PATCH /transfers/${encodedId}`,
      `PATCH /transfers/${encodedId}`,
    ]);

    const preparing = requestAt(backend, 0);
    expect(preparing.contentType).toBe("application/json; charset=utf-8");
    expect(JSON.parse(preparing.body)).toEqual({ status: "preparing" });

    const ready = requestAt(backend, 1);
    const readyBody = JSON.parse(ready.body) as Record<string, unknown>;
    expect(readyBody).toEqual({ status: "ready", archive_size: 408021221 });
    expectExactKeys(readyBody, ["status", "archive_size"]);
  });

  it("refuse un POST non 201 avec une erreur explicite", async () => {
    const backend = startStaticBackend(
      422,
      JSON.stringify({
        error: { code: "TRANSFER_RECIPIENT_UNKNOWN", message: "recipient thomas is unknown" },
      }),
    );
    const client = createHttpTransferClient(backend.baseUrl);

    const error = await captureTransferError(
      client.createTransfer({ recipientUserId: "thomas", volumeName: "mysql_client_x" }),
      "TRANSFER_CREATE_FAILED",
    );

    expect(error.message).toContain("422");
    expect(error.message).toContain("TRANSFER_RECIPIENT_UNKNOWN");
  });

  it("refuse un PATCH non 200 avec une erreur explicite", async () => {
    const backend = startStaticBackend(
      409,
      JSON.stringify({
        error: {
          code: "TRANSFER_TRANSITION_INVALID",
          message: "ready cannot follow failed",
        },
      }),
    );
    const client = createHttpTransferClient(backend.baseUrl);

    const error = await captureTransferError(
      client.updateStatus("tr_fake_1", "ready", 408021221),
      "TRANSFER_STATUS_UPDATE_FAILED",
    );

    expect(error.message).toContain("409");
    expect(error.message).toContain("TRANSFER_TRANSITION_INVALID");
  });

  it("refuse une réponse illisible ou incomplète", async () => {
    const scenarios: readonly {
      readonly label: string;
      readonly body: string;
      readonly mentions: string;
    }[] = [
      { label: "corps non JSON", body: "not json", mentions: "201" },
      {
        label: "storage.upload manquant",
        body: JSON.stringify({ ...CREATED_BODY, storage: {} }),
        mentions: '"storage.upload"',
      },
      {
        label: "id vide",
        body: JSON.stringify({ ...CREATED_BODY, id: "   " }),
        mentions: '"id"',
      },
      {
        label: "expires_at manquant",
        body: JSON.stringify({
          id: CREATED_BODY.id,
          status: CREATED_BODY.status,
          storage: CREATED_BODY.storage,
        }),
        mentions: '"expires_at"',
      },
    ];

    for (const scenario of scenarios) {
      const backend = startStaticBackend(201, scenario.body);
      const client = createHttpTransferClient(backend.baseUrl);

      const error = await captureTransferError(
        client.createTransfer({ recipientUserId: "thomas", volumeName: "mysql_client_x" }),
        "TRANSFER_CREATE_FAILED",
      );

      expect(error.message).toContain(scenario.mentions);
      expect(error.message).toContain(scenario.label === "corps non JSON" ? "not json" : "201");
    }
  });

  it("remonte l'échec réseau comme une erreur explicite", async () => {
    const failingFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const client = createHttpTransferClient("http://127.0.0.1:1", failingFetch);

    const createError = await captureTransferError(
      client.createTransfer({ recipientUserId: "thomas", volumeName: "mysql_client_x" }),
      "TRANSFER_CREATE_FAILED",
    );
    expect(createError.message).toContain("ECONNREFUSED");

    const statusError = await captureTransferError(
      client.updateStatus("tr_fake_1", "ready", 408021221),
      "TRANSFER_STATUS_UPDATE_FAILED",
    );
    expect(statusError.message).toContain("ECONNREFUSED");
  });

  it("normalise les barres obliques finales de la base", async () => {
    const backend = startHappyBackend();

    for (const suffix of ["/", "///"]) {
      const client = createHttpTransferClient(`${backend.baseUrl}${suffix}`);

      const descriptor = await client.createTransfer({
        recipientUserId: "thomas",
        volumeName: "mysql_client_x",
      });

      expect(descriptor.id).toBe("tr_fake_1");
    }

    // A trailing slash left in place would have produced "//transfers": a 404 from the fake.
    expect(backend.requests.length).toBe(2);
    expect(backend.requests.map((request) => request.pathname)).toEqual([
      "/transfers",
      "/transfers",
    ]);
  });
});
