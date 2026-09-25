import { applyTransferStatus, createTransfer } from "../transfers/transfers";
import { TransferError } from "../transfers/transfers.types";
import type {
  ApplyTransferStatusDeps,
  CreateTransferDeps,
  TransferErrorCode,
  TransferErrorResponse,
  TransferStore,
} from "../transfers/transfers.types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** Error body of every refused transfer request: exactly `{ error: { code, message } }`. */
function errorResponse(status: number, code: TransferErrorCode, message: string): Response {
  const body: TransferErrorResponse = { error: { code, message } };

  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * Builds the `POST /transfers` response creating a temporary transfer (task 16.4,
 * architecture §9.3).
 *
 * A valid body yields a 201 carrying exactly the frozen `CreateTransferResponse`
 * (`{ id, status, storage, expires_at }`). A non-parsable body or a body refused by
 * `createTransfer` yields `{ error: { code, message } }`: 400 `TRANSFER_BODY_INVALID`
 * for a malformed body, 422 `TRANSFER_RECIPIENT_UNKNOWN` for a recipient absent from
 * the colleagues configuration. Any other failure is not swallowed: it propagates to
 * the caller (the backend server), which owns logging.
 *
 * The handler is synchronous; its only side effect is the in-memory store.
 */
export function postTransfersHandler(
  rawBody: string,
  deps: CreateTransferDeps,
  store: TransferStore,
): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return errorResponse(
      400,
      "TRANSFER_BODY_INVALID",
      `POST /transfers body is not valid JSON: ${detail}`,
    );
  }

  try {
    return new Response(JSON.stringify(createTransfer(parsed, deps, store)), {
      status: 201,
      headers: JSON_HEADERS,
    });
  } catch (error) {
    if (error instanceof TransferError) {
      const status = error.code === "TRANSFER_RECIPIENT_UNKNOWN" ? 422 : 400;

      return errorResponse(status, error.code, error.message);
    }

    throw error;
  }
}

/**
 * Builds the `PATCH /transfers/{transferId}` response applying the §8 state machine
 * (task 16.6, architecture §9.4).
 *
 * A valid body yields a 200 carrying exactly the frozen `TransferStatusChangeResponse`
 * (`{ id, status, archive_size?, expires_at }`). A non-parsable body or a body refused by
 * `applyTransferStatus` yields `{ error: { code, message } }`: 400 `TRANSFER_BODY_INVALID`
 * for a malformed body, 400 `TRANSFER_STATUS_UNKNOWN` for an unknown status, 404
 * `TRANSFER_NOT_FOUND` for an unknown transfer, 409 `TRANSFER_TRANSITION_INVALID` for a
 * pair the state machine forbids, 409 `TRANSFER_EXPIRED` for a transfer whose retention
 * window elapsed. Any other failure is not swallowed: it propagates to the caller (the
 * backend server), which owns logging.
 *
 * The handler is synchronous; its only side effects are the in-memory store and the
 * injected ready-only notifier port (`deps.notifier`), which fires exactly once per valid
 * transition to "ready" (§8, task 16.6).
 */
export function patchTransfersHandler(
  rawBody: string,
  transferId: string,
  deps: ApplyTransferStatusDeps,
  store: TransferStore,
): Response {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return errorResponse(
      400,
      "TRANSFER_BODY_INVALID",
      `PATCH /transfers/{id} body is not valid JSON: ${detail}`,
    );
  }

  try {
    return new Response(
      JSON.stringify(applyTransferStatus(transferId, parsed, store, deps)),
      { status: 200, headers: JSON_HEADERS },
    );
  } catch (error) {
    if (error instanceof TransferError) {
      // Frozen codes → §9.4 HTTP surface; an exhaustive switch means a future code
      // cannot silently inherit a status instead of being surfaced deliberately.
      switch (error.code) {
        case "TRANSFER_NOT_FOUND":
          return errorResponse(404, error.code, error.message);
        case "TRANSFER_BODY_INVALID":
        case "TRANSFER_STATUS_UNKNOWN":
          return errorResponse(400, error.code, error.message);
        case "TRANSFER_TRANSITION_INVALID":
        case "TRANSFER_EXPIRED":
          return errorResponse(409, error.code, error.message);
        case "TRANSFER_RECIPIENT_UNKNOWN":
          // Creation-only code: applyTransferStatus never raises it on PATCH.
          return errorResponse(422, error.code, error.message);
      }
    }

    throw error;
  }
}
