import { DockerVolumesError } from "../docker/volumes.types";
import type { AgentVolume, VolumesResponse } from "../docker/volumes.types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Builds the `GET /volumes` handler exposing the local Docker Engine volumes
 * (architecture §9.4 contract).
 *
 * Only `{ items: [{ name, driver }] }` is exposed: each item is rebuilt
 * explicitly so no other Docker Engine field (`Labels`, `UsageData.Size`,
 * technical metadata) can leak. Engine order is preserved.
 *
 * A `DockerVolumesError` yields a controlled 503 payload carrying its code and
 * message; any other failure yields a generic 503 payload. The handler never
 * logs — logging belongs to the caller (the agent server).
 */
export function getVolumesHandler(
  listVolumes: () => Promise<VolumesResponse>,
): () => Promise<Response> {
  return async function volumesHandler(): Promise<Response> {
    try {
      const volumes = await listVolumes();
      const items: AgentVolume[] = volumes.items.map((volume) => ({
        name: volume.name,
        driver: volume.driver,
      }));

      return new Response(JSON.stringify({ items }), {
        status: 200,
        headers: JSON_HEADERS,
      });
    } catch (error) {
      if (error instanceof DockerVolumesError) {
        return new Response(
          JSON.stringify({ error: { code: error.code, message: error.message } }),
          { status: 503, headers: JSON_HEADERS },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            code: "DOCKER_UNREACHABLE",
            message: "Docker Engine query failed unexpectedly",
          },
        }),
        { status: 503, headers: JSON_HEADERS },
      );
    }
  };
}
