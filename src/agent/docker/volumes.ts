/**
 * Task 16.2 — lists the Docker Engine volumes (architecture §9.4).
 * `GET /v1.44/volumes` is queried through an injectable transport; every failure is
 * reported as a `DockerVolumesError` whose message names the path and the failing detail.
 * `Labels` and `UsageData` are tolerated in the Engine payload but never mapped: an
 * exposed item only carries `name` and `driver`. No caching, no module state.
 */

import { DockerVolumesError } from "./volumes.types";
import type { AgentVolume, DockerTransport, VolumesResponse } from "./volumes.types";

/** Engine API path listing the volumes; no `filters`/pagination parameters are needed here. */
const VOLUMES_PATH = "/v1.44/volumes";

/** Builds a `DOCKER_INVALID_RESPONSE` error; `detail` names the field violating the contract. */
function invalidResponse(detail: string): DockerVolumesError {
  return new DockerVolumesError(
    "DOCKER_INVALID_RESPONSE",
    `Docker volumes response is invalid: GET ${VOLUMES_PATH} (${detail})`,
  );
}

/**
 * Validates the parsed Engine body and maps its entries to `{ name, driver }` in Engine order.
 * `Volumes` null/undefined means the Engine holds no volume and yields an empty list.
 * `Name`/`Driver` are trimmed before storage, matching the `.trim()` validation.
 */
function parseVolumesResponse(parsed: unknown): VolumesResponse {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidResponse("expected a JSON object");
  }

  const { Volumes } = parsed as { Volumes?: unknown };

  if (Volumes === undefined || Volumes === null) {
    return { items: [] };
  }

  if (!Array.isArray(Volumes)) {
    throw invalidResponse('"Volumes" must be an array or null');
  }

  const items: AgentVolume[] = [];

  for (const [index, entry] of Volumes.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw invalidResponse(`entry #${index} must be an object`);
    }

    const { Name, Driver } = entry as { Name?: unknown; Driver?: unknown };

    if (typeof Name !== "string" || Name.trim() === "") {
      throw invalidResponse(`entry #${index} must have a non-empty string "Name"`);
    }
    if (typeof Driver !== "string" || Driver.trim() === "") {
      throw invalidResponse(
        `entry #${index} (Name "${Name.trim()}") must have a non-empty string "Driver"`,
      );
    }

    items.push({ name: Name.trim(), driver: Driver.trim() });
  }

  return { items };
}

/**
 * Lists the Docker Engine volumes through `transport`.
 * Throws `DockerVolumesError` with code `DOCKER_UNREACHABLE` (transport failure, e.g. socket
 * not mounted), `DOCKER_ENGINE_ERROR` (HTTP status other than 200) or `DOCKER_INVALID_RESPONSE`
 * (body that is not JSON or does not match the Engine contract).
 */
export async function listDockerVolumes(transport: DockerTransport): Promise<VolumesResponse> {
  let response: Response;
  try {
    response = await transport(VOLUMES_PATH);
  } catch (error) {
    throw new DockerVolumesError(
      "DOCKER_UNREACHABLE",
      `Docker Engine is unreachable for GET ${VOLUMES_PATH}: ${String(error)}`,
    );
  }

  if (response.status !== 200) {
    throw new DockerVolumesError(
      "DOCKER_ENGINE_ERROR",
      `Docker Engine answered HTTP ${response.status} for GET ${VOLUMES_PATH}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    throw invalidResponse(`it is not valid JSON: ${String(error)}`);
  }

  return parseVolumesResponse(parsed);
}

/**
 * Production transport to the Docker Engine over `socketPath` (e.g. `/var/run/docker.sock`).
 * Deliberately thin: failures are left to `listDockerVolumes` so that they can be classified.
 */
export function createDockerTransport(socketPath: string): DockerTransport {
  return (path: string): Promise<Response> => fetch(`http://docker${path}`, { unix: socketPath });
}
