/**
 * Task 16.7 — HTTP implementation of the source agent's backend port (architecture §6 step 3 and
 * step 5, §9.3, §9.4).
 *
 * This client only ever exchanges small JSON documents with the backend: one `POST /transfers` to
 * obtain the temporary presigned upload URL, then the §9.4 status changes (preparing → uploading →
 * ready/failed). The archive binary NEVER transits through here — it goes straight from the agent
 * to S3 through the presigned URL (see ./upload.ts).
 *
 * Every failure is explicit and loggable: a `SourceTransferError` carrying `TRANSFER_CREATE_FAILED`
 * or `TRANSFER_STATUS_UPDATE_FAILED`, a message naming the request, what the backend answered, and
 * the backend error code when the refusal body follows the `{ error: { code, message } }` shape.
 */

import {
  SourceTransferError,
  type CreateTransferRequest,
  type CreatedTransferDescriptor,
  type SourceTransferClient,
  type SourceTransferStatus,
} from "./source-transfer.types";

/** Wire content type of every agent→backend request (§9.3/§9.4): a small UTF-8 JSON document. */
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

/** Maximum length of a response body excerpt kept in an error message, so logs stay readable. */
const BODY_EXCERPT_LENGTH = 200;

/** The two failure codes this client may raise; never a bare fetch error. */
type ClientErrorCode = "TRANSFER_CREATE_FAILED" | "TRANSFER_STATUS_UPDATE_FAILED";

/**
 * Human-readable cause of a transport failure; a Node error `code` (ECONNREFUSED, ENOTFOUND…) is
 * kept even when the message does not repeat it, so the failure is diagnosable from logs alone.
 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    const { code } = error as NodeJS.ErrnoException;
    const prefixed = typeof code === "string" && code !== "" && !error.message.startsWith(code);
    return prefixed ? `${code}: ${error.message}` : error.message;
  }

  return String(error);
}

/** One-line, bounded excerpt of a response body, meant for an error message. */
function bodyExcerpt(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();

  return compact.length > BODY_EXCERPT_LENGTH
    ? `${compact.slice(0, BODY_EXCERPT_LENGTH)}…`
    : compact;
}

/** `422 Unprocessable Entity`, or just `422` when the runtime did not fill a status text. */
function describeStatus(response: Response): string {
  const statusText = response.statusText.trim();

  return statusText === "" ? String(response.status) : `${response.status} ${statusText}`;
}

/**
 * Extracts `code` / `message` from a `{ error: { code, message } }` refusal body (§9.3/§9.4), or
 * returns null when the body is not that shape.
 */
function backendErrorDetail(body: string): string | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const { error } = parsed as { readonly error?: unknown };

  if (typeof error !== "object" || error === null) {
    return null;
  }

  const { code, message } = error as { readonly code?: unknown; readonly message?: unknown };

  if (typeof code !== "string" || code.trim() === "") {
    return null;
  }

  return typeof message === "string" && message.trim() !== "" ? `${code}: ${message}` : code;
}

/** Response body as text, or null when even reading it failed; never masks the primary failure. */
async function readBodyText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Builds the HTTP implementation of `SourceTransferClient` talking to the backend at `baseUrl`
 * (§9.3, §9.4). Only small JSON documents travel through it: the archive binary is uploaded
 * straight to S3 by the caller.
 *
 * The base URL is normalized once (trailing slashes stripped) so a sloppy configuration cannot
 * produce a `…//transfers` request. `fetchImpl` is injectable so tests can force transport failures;
 * it defaults to the global `fetch`.
 */
export function createHttpTransferClient(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): SourceTransferClient {
  // Trailing slashes are stripped once so a sloppy base URL never yields a `…//transfers` request.
  const base = baseUrl.replace(/\/+$/, "");

  /** Sends one JSON request; a transport throw becomes the given explicit failure code. */
  async function send(
    url: string,
    method: "POST" | "PATCH",
    payload: string,
    code: ClientErrorCode,
  ): Promise<Response> {
    try {
      return await fetchImpl(url, { method, headers: JSON_HEADERS, body: payload });
    } catch (error) {
      throw new SourceTransferError(code, `${method} ${url} failed: ${describeFailure(error)}`);
    }
  }

  /** Turns a non-expected response into the given explicit failure, body excerpt included. */
  async function refusal(
    url: string,
    method: "POST" | "PATCH",
    response: Response,
    code: ClientErrorCode,
  ): Promise<SourceTransferError> {
    const body = await readBodyText(response);
    const detail =
      body === null ? "body unreadable" : (backendErrorDetail(body) ?? bodyExcerpt(body));
    const suffix = detail === "" ? "" : ` — ${detail}`;

    return new SourceTransferError(
      code,
      `${method} ${url} refused: HTTP ${describeStatus(response)}${suffix}`,
    );
  }

  /**
   * Reads a field the §9.3 201 body must carry, or throws `TRANSFER_CREATE_FAILED` naming the
   * missing/blank field and what was received instead (never a false success). `key` is the JSON
   * property; `label` is how the field is named in the message (`upload` → `storage.upload`).
   */
  function requiredField(
    source: Record<string, unknown>,
    key: string,
    label: string,
    url: string,
  ): string {
    const value = source[key];

    if (typeof value !== "string" || value.trim() === "") {
      throw new SourceTransferError(
        "TRANSFER_CREATE_FAILED",
        `POST ${url} returned HTTP 201 without a usable "${label}" (received ${JSON.stringify(value) ?? String(value)})`,
      );
    }

    return value;
  }

  return {
    async createTransfer(request: CreateTransferRequest): Promise<CreatedTransferDescriptor> {
      const url = `${base}/transfers`;
      const payload = JSON.stringify({
        recipient_user_id: request.recipientUserId,
        source_volume_name: request.volumeName,
      });
      const response = await send(url, "POST", payload, "TRANSFER_CREATE_FAILED");

      if (response.status !== 201) {
        throw await refusal(url, "POST", response, "TRANSFER_CREATE_FAILED");
      }

      const body = await readBodyText(response);

      if (body === null) {
        throw new SourceTransferError(
          "TRANSFER_CREATE_FAILED",
          `POST ${url} returned HTTP 201 but its body could not be read`,
        );
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(body);
      } catch {
        throw new SourceTransferError(
          "TRANSFER_CREATE_FAILED",
          `POST ${url} returned HTTP 201 with an unreadable JSON body: ${bodyExcerpt(body)}`,
        );
      }

      if (typeof parsed !== "object" || parsed === null) {
        throw new SourceTransferError(
          "TRANSFER_CREATE_FAILED",
          `POST ${url} returned HTTP 201 without a JSON object: ${bodyExcerpt(body)}`,
        );
      }

      const created = parsed as Record<string, unknown>;
      const id = requiredField(created, "id", "id", url);
      const storage = created["storage"];

      if (typeof storage !== "object" || storage === null) {
        throw new SourceTransferError(
          "TRANSFER_CREATE_FAILED",
          `POST ${url} returned HTTP 201 without a usable "storage.upload" (received ${JSON.stringify(storage) ?? String(storage)})`,
        );
      }

      const uploadUrl = requiredField(
        storage as Record<string, unknown>,
        "upload",
        "storage.upload",
        url,
      );
      const expiresAt = requiredField(created, "expires_at", "expires_at", url);

      return { id, uploadUrl, expiresAt };
    },

    async updateStatus(
      transferId: string,
      status: SourceTransferStatus,
      archiveSize?: number,
    ): Promise<void> {
      const url = `${base}/transfers/${encodeURIComponent(transferId)}`;
      const payload = JSON.stringify(
        archiveSize === undefined ? { status } : { status, archive_size: archiveSize },
      );
      const response = await send(url, "PATCH", payload, "TRANSFER_STATUS_UPDATE_FAILED");

      if (response.status !== 200) {
        throw await refusal(url, "PATCH", response, "TRANSFER_STATUS_UPDATE_FAILED");
      }
    },
  };
}
