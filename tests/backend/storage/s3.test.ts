import { describe, expect, it } from "bun:test";

import { createSigV4UploadMechanism, loadS3Config } from "../../../src/backend/storage/s3";
import {
  ARCHIVE_OBJECT_NAME,
  S3_KEY_PREFIX,
  S3ConfigError,
  volumeArchiveKey,
} from "../../../src/backend/storage/s3.types";
import type { S3PresignConfig } from "../../../src/backend/storage/s3.types";

/**
 * Contract under test (task 16.5, architecture §3, §9.3):
 * - the storage key is `docker-volume-transfers/{transferId}/volume.tar.zst`,
 *   derived from the transfer id only — never from the real volume name;
 * - the S3 configuration is complete or boot fails with a single explicit
 *   error listing every missing variable;
 * - `storage.upload` is a temporary SigV4 query-presigned PUT URL scoped to the
 *   transfer object, and no permanent credential ever reaches the client;
 * - the backend stays out of the binary path: `UNSIGNED-PAYLOAD`, no body.
 */

/** Fixed clock of these tests, so the presigned URL is fully deterministic. */
const FIXED_NOW = new Date("2026-09-24T15:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** Names of the five required S3 variables, in the fixed reporting order. */
const S3_VARIABLES = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

/** Complete, representative environment; individual tests blank or omit one entry. */
const fullEnv: Record<string, string | undefined> = {
  S3_ENDPOINT: "https://s3.example.com",
  S3_REGION: "eu-west-1",
  S3_BUCKET: "docker-drop-archives",
  S3_ACCESS_KEY_ID: "AKIAEXAMPLEACCESSKEYID",
  S3_SECRET_ACCESS_KEY: "secret/access+key",
};

const config: S3PresignConfig = {
  endpoint: "https://s3.example.com",
  region: "eu-west-1",
  bucket: "docker-drop-archives",
  accessKeyId: "AKIAEXAMPLEACCESSKEYID",
  secretAccessKey: "secret/access+key",
};

/** `20260924/eu-west-1/s3/aws4_request`, URI-encoded as it appears in the URL. */
const encodedCredential = encodeURIComponent(
  `${config.accessKeyId}/20260924/${config.region}/s3/aws4_request`,
);

/** Expected path-style object URL prefix, minus the signed query. */
const OBJECT_URL_PREFIX = `${config.endpoint}/${config.bucket}/docker-volume-transfers/tr_x/volume.tar.zst?`;

const mechanism = createSigV4UploadMechanism(config, () => FIXED_NOW);

/** Runs `run` and returns whatever it threw; fails loudly when it returned normally. */
function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it returned normally.");
}

/** Asserts an explicit, loggable `S3ConfigError` reporting exactly `missing`, in order. */
function expectS3ConfigError(error: unknown, missing: readonly string[]): S3ConfigError {
  expect(error).toBeInstanceOf(S3ConfigError);
  const configError = error as S3ConfigError;
  expect(configError.name).toBe("S3ConfigError");
  expect(configError.code).toBe("S3_CONFIG_INCOMPLETE");
  expect(configError.missing).toEqual(missing);
  for (const name of missing) {
    expect(configError.message).toContain(name);
  }
  return configError;
}

/** Reads the `X-Amz-Signature` value of a presigned URL; fails when it is absent. */
function signatureOf(url: string): string {
  const parsed = /[&?]X-Amz-Signature=([0-9a-f]+)$/.exec(url);
  if (parsed?.[1] === undefined) {
    throw new Error(`Presigned URL carries no X-Amz-Signature: ${url}`);
  }
  return parsed[1];
}

describe("volumeArchiveKey", () => {
  it("produit la clé S3 figée §3", () => {
    expect(S3_KEY_PREFIX).toBe("docker-volume-transfers");
    expect(ARCHIVE_OBJECT_NAME).toBe("volume.tar.zst");
    expect(volumeArchiveKey("tr_abc")).toBe("docker-volume-transfers/tr_abc/volume.tar.zst");
  });

  it("dérive la clé du transferId seul", () => {
    // The signature takes no volume name: a volume rename cannot move the object.
    expect(volumeArchiveKey("tr_abc").split("/")).toEqual([
      S3_KEY_PREFIX,
      "tr_abc",
      ARCHIVE_OBJECT_NAME,
    ]);
    expect(volumeArchiveKey("tr_other").split("/")[1]).toBe("tr_other");
    expect(volumeArchiveKey("tr_abc")).not.toBe(volumeArchiveKey("tr_other"));
  });
});

describe("loadS3Config", () => {
  it("charge une configuration complète en nettoyant les valeurs", () => {
    const loaded = loadS3Config({
      S3_ENDPOINT: "  https://s3.example.com\t",
      S3_REGION: " eu-west-1\n",
      S3_BUCKET: " docker-drop-archives ",
      S3_ACCESS_KEY_ID: " AKIAEXAMPLEACCESSKEYID",
      S3_SECRET_ACCESS_KEY: "secret/access+key  ",
    });

    expect(loaded).toEqual(config);
    expect(Object.keys(loaded)).toEqual([
      "endpoint",
      "region",
      "bucket",
      "accessKeyId",
      "secretAccessKey",
    ]);
  });

  it("refuse les variables manquantes en une seule erreur", () => {
    const error = captureThrown(() => loadS3Config({}));

    expectS3ConfigError(error, S3_VARIABLES);
  });

  it("signale exactement la variable blanche ou absente", () => {
    for (const value of ["   ", undefined, "", "\t\n"] as const) {
      expectS3ConfigError(
        captureThrown(() => loadS3Config({ ...fullEnv, S3_BUCKET: value })),
        ["S3_BUCKET"],
      );
    }

    expectS3ConfigError(
      captureThrown(() => loadS3Config({ ...fullEnv, S3_SECRET_ACCESS_KEY: undefined })),
      ["S3_SECRET_ACCESS_KEY"],
    );
  });
});

describe("createSigV4UploadMechanism", () => {
  it("presigne une URL PUT SigV4 temporaire et limitée à l'objet du transfert", () => {
    const expiresAt = new Date(FIXED_NOW.getTime() + DAY_MS);

    const url = mechanism.presignUpload("tr_x", expiresAt);

    expect(url.startsWith(OBJECT_URL_PREFIX)).toBe(true);
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain(`X-Amz-Credential=${encodedCredential}`);
    expect(url).toContain("X-Amz-Date=20260924T153000Z");
    expect(url).toContain("X-Amz-Expires=86400");
    expect(url).toContain("X-Amz-SignedHeaders=host");
    expect(signatureOf(url)).toMatch(/^[0-9a-f]{64}$/);

    // Signed query: SigV4-sorted parameter order, signature appended last.
    expect(url).toBe(
      `${OBJECT_URL_PREFIX}X-Amz-Algorithm=AWS4-HMAC-SHA256` +
        `&X-Amz-Credential=${encodedCredential}` +
        "&X-Amz-Date=20260924T153000Z" +
        "&X-Amz-Expires=86400" +
        "&X-Amz-SignedHeaders=host" +
        `&X-Amz-Signature=${signatureOf(url)}`,
    );
  });

  it("encode le transferId dans le chemin de l'objet", () => {
    const url = mechanism.presignUpload("tr archive été", new Date(FIXED_NOW.getTime() + DAY_MS));

    expect(url).toContain("/docker-volume-transfers/tr%20archive%20%C3%A9t%C3%A9/volume.tar.zst?");
    expect(url).not.toContain("tr archive été");
  });

  it("borne la validité au cycle de vie du transfert", () => {
    const presignFor = (offsetMs: number): string =>
      mechanism.presignUpload("tr_x", new Date(FIXED_NOW.getTime() + offsetMs));

    // Unambiguous delimiter: `X-Amz-Expires` is always followed by the signed headers.
    expect(presignFor(30_000)).toContain("X-Amz-Expires=30&X-Amz-SignedHeaders=host");
    expect(presignFor(2_500)).toContain("X-Amz-Expires=3&X-Amz-SignedHeaders=host");
    expect(presignFor(10 * DAY_MS)).toContain("X-Amz-Expires=604800&X-Amz-SignedHeaders=host");
    expect(presignFor(-1)).toContain("X-Amz-Expires=1&X-Amz-SignedHeaders=host");
    expect(presignFor(0)).toContain("X-Amz-Expires=1&X-Amz-SignedHeaders=host");
  });

  it("est déterministe par transferId", () => {
    const expiresAt = new Date(FIXED_NOW.getTime() + DAY_MS);

    const first = mechanism.presignUpload("tr_x", expiresAt);
    const second = mechanism.presignUpload("tr_x", expiresAt);
    const other = mechanism.presignUpload("tr_y", expiresAt);

    expect(first).toBe(second);
    expect(other).not.toBe(first);
    expect(signatureOf(other)).not.toBe(signatureOf(first));
    expect(other).toContain("/docker-volume-transfers/tr_y/volume.tar.zst?");
  });

  it("n'expose jamais le credential permanent", () => {
    const url = mechanism.presignUpload("tr_x", new Date(FIXED_NOW.getTime() + DAY_MS));

    expect(url).not.toContain(config.secretAccessKey);
    expect(url).not.toContain(encodeURIComponent(config.secretAccessKey));

    // Exactly the six SigV4 query parameters — no extra credential field.
    const query = url.slice(url.indexOf("?") + 1);
    expect(query.split("&").map((pair) => pair.slice(0, pair.indexOf("=")))).toEqual([
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
    ]);
  });
});
