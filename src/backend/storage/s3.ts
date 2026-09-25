/**
 * Task 16.5 — temporary, single-object S3 upload mechanism (architecture §3, §9.3, §16.5).
 *
 * The backend never relays archive binaries: this module only mints the wire
 * value of `storage.upload`, an AWS SigV4 query-presigned PUT URL addressing
 * `volumeArchiveKey(transferId)`. The descriptor is temporary (valid at most
 * until the transfer expiration), scoped to that single object, and carries no
 * permanent credential — the secret only feeds the HMAC key derivation inside
 * this process. Pure and synchronous; `node:crypto` is the only import.
 */

import { createHash, createHmac } from "node:crypto";

import { S3ConfigError, volumeArchiveKey } from "./s3.types";
import type { S3PresignConfig, S3UploadMechanism } from "./s3.types";

/** SigV4 algorithm identifier, signed in `X-Amz-Algorithm` and in the string to sign. */
const ALGORITHM = "AWS4-HMAC-SHA256";

/** Service name of the SigV4 credential scope. */
const SERVICE = "s3";

/** Request terminator of the SigV4 credential scope. */
const REQUEST_TERMINATOR = "aws4_request";

/** The only header covered by the signature, mandatory for S3. */
const SIGNED_HEADERS = "host";

/** The presigner never sees the archive: S3 must accept an unsigned payload. */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** SigV4 upper bound of a descriptor's validity: seven days. */
const MAX_EXPIRES_SECONDS = 604_800;

/** SigV4 lower bound: a descriptor is always strictly temporary. */
const MIN_EXPIRES_SECONDS = 1;

/**
 * Loads the server-side S3 configuration from `env`.
 * Absent, non-string and blank (whitespace-only) variables are all reported at
 * once through a single `S3ConfigError`, whose `missing` lists them in the
 * fixed S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID,
 * S3_SECRET_ACCESS_KEY order; kept values are trimmed.
 */
export function loadS3Config(env: Record<string, string | undefined>): S3PresignConfig {
  const missing: string[] = [];
  const read = (name: string): string => {
    const raw = env[name];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") {
      missing.push(name);
    }
    return value;
  };

  // Fields are evaluated left to right, so `missing` keeps the required order.
  // The "" placeholders are never observable: the guard below throws first.
  const config: S3PresignConfig = {
    endpoint: read("S3_ENDPOINT"),
    region: read("S3_REGION"),
    bucket: read("S3_BUCKET"),
    accessKeyId: read("S3_ACCESS_KEY_ID"),
    secretAccessKey: read("S3_SECRET_ACCESS_KEY"),
  };

  if (missing.length > 0) {
    throw new S3ConfigError(missing);
  }

  return config;
}

/** One HMAC-SHA256 step of the SigV4 key-derivation chain. */
function hmacSha256(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/**
 * Strict SigV4 URI encoding: every UTF-8 byte except `A-Z a-z 0-9 - _ . ~`
 * becomes `%XY` (uppercase hex). The AWS documentation warns that the
 * platform-standard encoders (e.g. `encodeURIComponent`, which leaves
 * `! * ' ( )` raw) produce signatures that strictly canonicalizing S3
 * gateways reject with 403 SignatureDoesNotMatch.
 */
function uriEncode(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const char = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9\-_.~]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

/**
 * Builds the SigV4 query-presigned PUT mechanism of `config` (§9.3).
 * `now` is injectable so tests — and any future verification — can pin the
 * clock; every call is pure and synchronous, and errors propagate untouched.
 */
export function createSigV4UploadMechanism(
  config: S3PresignConfig,
  now: () => Date = () => new Date(),
): S3UploadMechanism {
  // Trailing slashes in S3_ENDPOINT (a frequent operator slip) would corrupt
  // both the canonical host and the final URL (`…//docker-volume-transfers/…`),
  // making every presigned descriptor unverifiable; normalize the base once.
  const endpoint = config.endpoint.replace(/\/+$/, "");
  // Host header: the endpoint without its scheme (path-style virtual host).
  const host = endpoint.replace(/^https?:\/\//i, "");

  return {
    presignUpload(transferId: string, expiresAt: Date): string {
      // Frozen key layout, strictly URI-encoded segment by segment with `/` preserved.
      const encodedKey = volumeArchiveKey(transferId)
        .split("/")
        .map(uriEncode)
        .join("/");
      const objectPath = `/${config.bucket}/${encodedKey}`;

      // `toISOString` is UTC; SigV4 wants the basic form YYYYMMDDTHHMMSSZ.
      const signedAt = now();
      const amzdate = signedAt.toISOString().replace(/[-:]|\.\d{3}/g, "");
      const datestamp = amzdate.slice(0, 8);
      const credentialScope = `${datestamp}/${config.region}/${SERVICE}/${REQUEST_TERMINATOR}`;

      // Validity follows the transfer lifecycle, clamped to the SigV4 bounds.
      const expiresSeconds = Math.min(
        MAX_EXPIRES_SECONDS,
        Math.max(
          MIN_EXPIRES_SECONDS,
          Math.ceil((expiresAt.getTime() - signedAt.getTime()) / 1000),
        ),
      );

      // Signed query parameters, in the sorted order SigV4 canonicalization requires.
      const canonicalQuery = [
        `X-Amz-Algorithm=${ALGORITHM}`,
        `X-Amz-Credential=${uriEncode(`${config.accessKeyId}/${credentialScope}`)}`,
        `X-Amz-Date=${amzdate}`,
        `X-Amz-Expires=${expiresSeconds}`,
        `X-Amz-SignedHeaders=${SIGNED_HEADERS}`,
      ].join("&");

      const canonicalRequest = [
        "PUT",
        objectPath,
        canonicalQuery,
        `host:${host}`,
        "",
        SIGNED_HEADERS,
        UNSIGNED_PAYLOAD,
      ].join("\n");

      const stringToSign = [
        ALGORITHM,
        amzdate,
        credentialScope,
        createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
      ].join("\n");

      // Signing key: AWS4{secret} → datestamp → region → service → terminator.
      const dateKey = hmacSha256(`AWS4${config.secretAccessKey}`, datestamp);
      const regionKey = hmacSha256(dateKey, config.region);
      const serviceKey = hmacSha256(regionKey, SERVICE);
      const signature = createHmac("sha256", hmacSha256(serviceKey, REQUEST_TERMINATOR))
        .update(stringToSign, "utf8")
        .digest("hex");

      return `${endpoint}${objectPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
    },
  };
}