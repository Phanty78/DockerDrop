import { describe, expect, it } from "bun:test";

import { DockerVolumesError } from "../../../src/agent/docker/volumes.types";
import type { VolumesResponse } from "../../../src/agent/docker/volumes.types";
import { getVolumesHandler } from "../../../src/agent/http/volumes.route";

/**
 * Contract under test: `getVolumesHandler(listVolumes)` returns a handler that
 * exposes ONLY `{ items: [{ name, driver }] }` on success and a controlled
 * 503 `{ error: { code, message } }` on failure.
 */

/** Shape intentionally loose: the assertions must be able to detect leaked keys. */
interface VolumesResponseBody {
  items: Array<Record<string, unknown>>;
}

/** Same loose shape for the 503 payload. */
interface VolumesErrorBody {
  error: Record<string, unknown>;
  [key: string]: unknown;
}

describe("getVolumesHandler", () => {
  it("expose exactement { items: [{ name, driver }] } et masque les champs techniques du moteur", async () => {
    // The Engine payload also carries `Labels` and `UsageData`: they must never be surfaced.
    const engineVolume = {
      name: "mysql_client_x",
      driver: "local",
      Labels: { "com.docker.compose.project": "dockerdrop" },
      UsageData: { Size: 12_345 },
    };
    const listVolumes = async (): Promise<VolumesResponse> => ({ items: [engineVolume] });

    const response = await getVolumesHandler(listVolumes)();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as VolumesResponseBody;

    expect(body).toEqual({ items: [{ name: "mysql_client_x", driver: "local" }] });

    // No extra top-level metadata, no warning, no Engine detail.
    expect(Object.keys(body)).toEqual(["items"]);
    // Each item exposes exactly `name` and `driver` (no Labels, no size, no technical field).
    expect(body.items.map((item) => Object.keys(item).sort())).toEqual([["driver", "name"]]);
  });

  it("retourne une liste vide quand le moteur ne possède aucun volume", async () => {
    const listVolumes = async (): Promise<VolumesResponse> => ({ items: [] });

    const response = await getVolumesHandler(listVolumes)();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as VolumesResponseBody;

    expect(body).toEqual({ items: [] });
    expect(Object.keys(body)).toEqual(["items"]);
  });

  it("préserve l'ordre des volumes renvoyé par le moteur", async () => {
    const listVolumes = async (): Promise<VolumesResponse> => ({
      items: [
        { name: "dockerdrop_mysql_data", driver: "local" },
        { name: "redis_cache", driver: "local" },
        { name: "nfs_share", driver: "nfs" },
      ],
    });

    const response = await getVolumesHandler(listVolumes)();

    expect(response.status).toBe(200);

    const body = (await response.json()) as VolumesResponseBody;

    expect(body.items.map((item) => item["name"])).toEqual([
      "dockerdrop_mysql_data",
      "redis_cache",
      "nfs_share",
    ]);
    expect(body.items.map((item) => item["driver"])).toEqual(["local", "local", "nfs"]);
    expect(body.items.map((item) => Object.keys(item).sort())).toEqual([
      ["driver", "name"],
      ["driver", "name"],
      ["driver", "name"],
    ]);
  });

  it("retourne 503 avec le code et le message du DockerVolumesError", async () => {
    const engineMessage =
      "Docker Engine is unreachable at unix:///var/run/docker.sock (socket hang up)";
    const listVolumes = async (): Promise<VolumesResponse> => {
      throw new DockerVolumesError("DOCKER_UNREACHABLE", engineMessage);
    };

    const response = await getVolumesHandler(listVolumes)();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as VolumesErrorBody;

    expect(body).toEqual({
      error: { code: "DOCKER_UNREACHABLE", message: engineMessage },
    });

    // No other top-level key, no stack, no Engine payload.
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  });

  it("retourne 503 avec une erreur générique contrôlée quand le moteur échoue de façon inattendue", async () => {
    const listVolumes = async (): Promise<VolumesResponse> => {
      throw new Error("socket hang up");
    };

    const response = await getVolumesHandler(listVolumes)();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as VolumesErrorBody;

    expect(body).toEqual({
      error: {
        code: "DOCKER_UNREACHABLE",
        message: "Docker Engine query failed unexpectedly",
      },
    });
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
  });
});
