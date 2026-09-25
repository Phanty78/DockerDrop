import { describe, expect, it } from "bun:test";

import { listDockerVolumes } from "../../../src/agent/docker/volumes";
import {
  DockerVolumesError,
  type DockerTransport,
  type DockerVolumesErrorCode,
} from "../../../src/agent/docker/volumes.types";

/**
 * Contract under test: `listDockerVolumes(transport)` queries the Docker Engine at
 * `/v1.44/volumes` and exposes ONLY `{ items: [{ name, driver }] }`. The Engine is
 * mocked through the injected transport; no Docker socket is ever contacted.
 */

/** Engine API path the module must request. */
const VOLUMES_PATH = "/v1.44/volumes";

/** Shape intentionally loose: the assertions must detect a leaked `Labels`/`UsageData`/`Mountpoint` key. */
interface LooseVolumesBody {
  items: Array<Record<string, unknown>>;
}

/** Builds the mocked Engine transport resolving `body` as JSON with the given HTTP status. */
function jsonTransport(body: unknown, status = 200): DockerTransport {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

/**
 * Asserts that `listDockerVolumes(transport)` rejects with a `DockerVolumesError`
 * carrying the expected code and a non-empty, loggable message.
 */
async function captureDockerVolumesError(
  transport: DockerTransport,
  expectedCode: DockerVolumesErrorCode,
): Promise<DockerVolumesError> {
  let caught: unknown;
  try {
    await listDockerVolumes(transport);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(DockerVolumesError);

  const error = caught as DockerVolumesError;
  expect(error.code).toBe(expectedCode);
  expect(error.message.length).toBeGreaterThan(0);

  return error;
}

describe("listDockerVolumes", () => {
  describe("réponse valide du moteur", () => {
    it("convertit plusieurs volumes en items { name, driver } et préserve l'ordre du moteur", async () => {
      const requestedPaths: string[] = [];
      const transport: DockerTransport = (path) => {
        requestedPaths.push(path);
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Volumes: [
                {
                  Name: "mysql_client_x",
                  Driver: "local",
                  Labels: { env: "dev" },
                  UsageData: { Size: 4096 },
                },
                { Name: "redis_data", Driver: "local" },
                { Name: "nfs_share", Driver: "nfs", Mountpoint: "/mnt/nfs" },
              ],
              Warnings: ["unused volume"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      };

      const body = (await listDockerVolumes(transport)) as unknown as LooseVolumesBody;

      expect(requestedPaths).toEqual([VOLUMES_PATH]);
      expect(body).toEqual({
        items: [
          { name: "mysql_client_x", driver: "local" },
          { name: "redis_data", driver: "local" },
          { name: "nfs_share", driver: "nfs" },
        ],
      });
      // Only `items` is exposed; each item carries exactly `name` and `driver`.
      expect(Object.keys(body)).toEqual(["items"]);
      expect(body.items.map((item) => Object.keys(item).sort())).toEqual([
        ["driver", "name"],
        ["driver", "name"],
        ["driver", "name"],
      ]);
    });

    it("expose le nom et le driver d'un volume unique", async () => {
      const body = (await listDockerVolumes(
        jsonTransport({ Volumes: [{ Name: "dockerdrop_data", Driver: "local" }], Warnings: null }),
      )) as unknown as LooseVolumesBody;

      expect(body.items).toEqual([{ name: "dockerdrop_data", driver: "local" }]);
      expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["driver", "name"]);
    });
  });

  describe("champs tolérés mais non exposés", () => {
    it("tolère Labels et UsageData sans les exposer", async () => {
      const body = (await listDockerVolumes(
        jsonTransport({
          Volumes: [
            {
              Name: "with_labels",
              Driver: "local",
              Labels: { role: "database", env: "prod" },
              UsageData: { Size: 2048, RefCount: 3 },
            },
          ],
        }),
      )) as unknown as LooseVolumesBody;

      expect(body).toEqual({ items: [{ name: "with_labels", driver: "local" }] });
      expect(Object.keys(body.items[0] ?? {})).toEqual(["name", "driver"]);
    });

    it("accepte une entrée sans Labels ni UsageData", async () => {
      const body = (await listDockerVolumes(
        jsonTransport({ Volumes: [{ Name: "bare_volume", Driver: "local" }] }),
      )) as unknown as LooseVolumesBody;

      expect(body).toEqual({ items: [{ name: "bare_volume", driver: "local" }] });
    });
  });

  describe("normalisation", () => {
    it("stocke les Name et Driver rembourrés en valeurs trimées", async () => {
      const body = (await listDockerVolumes(
        jsonTransport({ Volumes: [{ Name: "  mysql_client_x  ", Driver: " local " }] }),
      )) as unknown as LooseVolumesBody;

      expect(body).toEqual({ items: [{ name: "mysql_client_x", driver: "local" }] });
      expect(Object.keys(body.items[0] ?? {})).toEqual(["name", "driver"]);
    });
  });

  describe("moteur sans volume", () => {
    it("retourne une liste vide quand le moteur répond Volumes: null", async () => {
      const body = (await listDockerVolumes(
        jsonTransport({ Volumes: null, Warnings: [] }),
      )) as unknown as LooseVolumesBody;

      expect(body).toEqual({ items: [] });
      expect(Object.keys(body)).toEqual(["items"]);
    });

    it("retourne une liste vide quand la réponse omet Volumes", async () => {
      const body = (await listDockerVolumes(jsonTransport({}))) as unknown as LooseVolumesBody;

      expect(body).toEqual({ items: [] });
    });
  });

  describe("moteur injoignable", () => {
    it("rejette DOCKER_UNREACHABLE quand le transport échoue", async () => {
      const transport: DockerTransport = () =>
        Promise.reject(new Error("connect EACCES /var/run/docker.sock"));

      const error = await captureDockerVolumesError(transport, "DOCKER_UNREACHABLE");

      expect(error.message).toContain(VOLUMES_PATH);
      expect(error.message).toContain("connect EACCES /var/run/docker.sock");
    });
  });

  describe("erreur du moteur", () => {
    it("rejette DOCKER_ENGINE_ERROR quand le moteur répond 500", async () => {
      const error = await captureDockerVolumesError(
        jsonTransport({ message: "Internal Server Error" }, 500),
        "DOCKER_ENGINE_ERROR",
      );

      expect(error.message).toContain("500");
      expect(error.message).toContain(VOLUMES_PATH);
    });

    it("rejette DOCKER_ENGINE_ERROR avant de lire un corps non JSON quand le statut n'est pas 200", async () => {
      const transport: DockerTransport = () =>
        Promise.resolve(
          new Response("upstream failure", {
            status: 500,
            headers: { "content-type": "text/plain" },
          }),
        );

      const error = await captureDockerVolumesError(transport, "DOCKER_ENGINE_ERROR");

      expect(error.message).toContain("500");
    });
  });

  describe("réponse invalide", () => {
    it("rejette DOCKER_INVALID_RESPONSE quand le corps n'est pas du JSON", async () => {
      const transport: DockerTransport = () =>
        Promise.resolve(
          new Response("upstream failure", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );

      const error = await captureDockerVolumesError(transport, "DOCKER_INVALID_RESPONSE");

      expect(error.message.toLowerCase()).toContain("json");
      expect(error.message).toContain(VOLUMES_PATH);
    });

    const invalidBodies = [
      { name: "un corps qui est un tableau JSON", body: [], detail: "object" },
      { name: "un corps JSON null", body: null, detail: "object" },
      { name: "un Volumes qui n'est pas un tableau", body: { Volumes: "local" }, detail: '"Volumes"' },
      { name: "une entrée qui n'est pas un objet", body: { Volumes: ["mysql_client_x"] }, detail: "entry #0" },
      { name: "un Name absent", body: { Volumes: [{ Driver: "local" }] }, detail: '"Name"' },
      { name: "un Name vide", body: { Volumes: [{ Name: "   ", Driver: "local" }] }, detail: '"Name"' },
      { name: "un Name qui n'est pas une chaîne", body: { Volumes: [{ Name: 42, Driver: "local" }] }, detail: '"Name"' },
      { name: "un Driver absent", body: { Volumes: [{ Name: "mysql_client_x" }] }, detail: '"Driver"' },
      { name: "un Driver vide", body: { Volumes: [{ Name: "mysql_client_x", Driver: "  " }] }, detail: '"Driver"' },
      { name: "un Driver qui n'est pas une chaîne", body: { Volumes: [{ Name: "mysql_client_x", Driver: null }] }, detail: '"Driver"' },
    ] as const;

    for (const { name, body, detail } of invalidBodies) {
      it(`rejette DOCKER_INVALID_RESPONSE pour ${name}`, async () => {
        const error = await captureDockerVolumesError(
          jsonTransport(body),
          "DOCKER_INVALID_RESPONSE",
        );

        expect(error.message).toContain(detail);
      });
    }

    it("nomme l'entrée fautive et son champ", async () => {
      const error = await captureDockerVolumesError(
        jsonTransport({
          Volumes: [
            { Name: "mysql_client_x", Driver: "local" },
            { Name: "redis_data", Driver: "" },
          ],
        }),
        "DOCKER_INVALID_RESPONSE",
      );

      expect(error.message).toContain("entry #1");
      expect(error.message).toContain('"Driver"');
    });
  });

  describe("aucun cache", () => {
    it("interroge le moteur à chaque appel et reflète son état courant", async () => {
      const snapshots: unknown[] = [
        { Volumes: [{ Name: "first_volume", Driver: "local" }] },
        {
          Volumes: [
            { Name: "first_volume", Driver: "local" },
            { Name: "second_volume", Driver: "nfs" },
          ],
        },
      ];
      let calls = 0;
      const transport: DockerTransport = () => {
        const snapshot = snapshots[calls] ?? { Volumes: null };
        calls += 1;
        return Promise.resolve(
          new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      };

      const first = (await listDockerVolumes(transport)) as unknown as LooseVolumesBody;
      const second = (await listDockerVolumes(transport)) as unknown as LooseVolumesBody;

      expect(calls).toBe(2);
      expect(first).toEqual({ items: [{ name: "first_volume", driver: "local" }] });
      expect(second).toEqual({
        items: [
          { name: "first_volume", driver: "local" },
          { name: "second_volume", driver: "nfs" },
        ],
      });
    });
  });
});
