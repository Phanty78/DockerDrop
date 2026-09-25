import { createTransfer } from "../transfers/transfers";
import { TransferError } from "../transfers/transfers.types";
import type {
  CreateTransferDeps,
  TransferErrorResponse,
  TransferStore,
} from "../transfers/transfers.types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

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
 * The handler is synchronous and side-effect free beyond the in-memory store.
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
    const body: TransferErrorResponse = {
      error: {
        code: "TRANSFER_BODY_INVALID",
        message: `POST /transfers body is not valid JSON: ${detail}`,
      },
    };

    return new Response(JSON.stringify(body), { status: 400, headers: JSON_HEADERS });
  }

  try {
    return new Response(JSON.stringify(createTransfer(parsed, deps, store)), {
      status: 201,
      headers: JSON_HEADERS,
    });
  } catch (error) {
    if (error instanceof TransferError) {
      const body: TransferErrorResponse = {
        error: { code: error.code, message: error.message },
      };
      const status = error.code === "TRANSFER_RECIPIENT_UNKNOWN" ? 422 : 400;

      return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
    }

    throw error;
  }
}
