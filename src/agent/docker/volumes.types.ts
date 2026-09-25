/**
 * Frozen contract for task 16.2 — Docker volumes listing in the local agent.
 * Docker Engine API (subset consumed): `GET /v1.44/volumes` returns
 * `{ "Volumes": [{ "Name": "…", "Driver": "local", "Labels": …, "UsageData": { "Size": … } }], "Warnings": […] }`
 * Shape exposed by GET /volumes: `{ "items": [{ "name": "mysql_client_x", "driver": "local" }] }`
 *
 * Only `name` and `driver` are exposed (§9.4 contract): `Labels` and size data
 * are tolerated in the Docker response but never surfaced to the interface.
 */

/** Raw Docker Engine volume entry — only the consumed subset is typed; extra fields are tolerated. */
export interface DockerEngineVolume {
  Name: string;
  Driver: string;
  Labels?: Record<string, string> | null;
  UsageData?: { Size?: number } | null;
}

/** Body of `GET /v1.44/volumes` — `Volumes` is null when the Engine has no volume. */
export interface DockerEngineVolumesResponse {
  Volumes?: DockerEngineVolume[] | null;
  Warnings?: string[] | null;
}

/** Volume as exposed to the interface by GET /volumes. */
export interface AgentVolume {
  name: string;
  driver: string;
}

export interface VolumesResponse {
  items: AgentVolume[];
}

export type DockerVolumesErrorCode =
  | "DOCKER_UNREACHABLE"
  | "DOCKER_ENGINE_ERROR"
  | "DOCKER_INVALID_RESPONSE";

/** Explicit, loggable error raised when the Docker Engine cannot be queried. */
export class DockerVolumesError extends Error {
  readonly code: DockerVolumesErrorCode;

  constructor(code: DockerVolumesErrorCode, message: string) {
    super(message);
    this.name = "DockerVolumesError";
    this.code = code;
  }
}

/**
 * Minimal injectable transport to the Docker Engine: resolves the HTTP response
 * for an Engine API path (e.g. `/v1.44/volumes`). Mocked in unit tests; the
 * production implementation talks to the local Docker socket.
 */
export type DockerTransport = (path: string) => Promise<Response>;
