/**
 * Local agent entrypoint — task 16.2 wiring.
 * Serves `GET /volumes` from the Docker Engine of the local machine.
 *
 * Binds to 127.0.0.1 only (architecture §2.2/§16.16 security rule): the browser
 * never touches the Docker socket, and the agent must not be reachable from the
 * network. A wider interface would have to be validated explicitly.
 *
 * Configuration:
 * - `AGENT_PORT`: listen port (default: 8790).
 * - `DOCKER_SOCKET`: Docker Engine socket path (default: `/var/run/docker.sock`).
 */
import { createDockerTransport, listDockerVolumes } from "./docker/volumes";
import { DockerVolumesError } from "./docker/volumes.types";
import type { DockerTransport, VolumesResponse } from "./docker/volumes.types";
import { getVolumesHandler } from "./http/volumes.route";

const port = Number(process.env.AGENT_PORT ?? 8790);
const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

const transport: DockerTransport = createDockerTransport(socketPath);

/**
 * Queries the Engine and logs failures with their code before rethrowing: the
 * handler stays the single place building error responses, the server keeps the
 * failures loggable.
 */
async function listVolumesLogged(): Promise<VolumesResponse> {
  try {
    return await listDockerVolumes(transport);
  } catch (error) {
    if (error instanceof DockerVolumesError) {
      console.error(`[volumes] ${error.code}: ${error.message}`);
    } else {
      console.error("[volumes] unexpected failure:", error);
    }
    throw error;
  }
}

const volumesHandler = getVolumesHandler(listVolumesLogged);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/volumes") {
      return await volumesHandler();
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`DockerDrop agent listening on http://127.0.0.1:${port}`);
