/**
 * Central backend entrypoint — task 16.1 wiring.
 * Serves `GET /users` from the colleagues configuration file.
 *
 * Configuration:
 * - `USERS_CONFIG_PATH`: path to users.json (default: `data/users.json`).
 * - `PORT`: listen port (default: 8787).
 *
 * Binds to 127.0.0.1 by default; a wider interface must be validated explicitly.
 */
import { loadUsersConfig } from "./config/users";
import { getUsersHandler } from "./http/users.route";
import { UsersConfigError } from "./config/users.types";

const configPath = process.env.USERS_CONFIG_PATH ?? "data/users.json";
const port = Number(process.env.PORT ?? 8787);

const config = await loadUsersConfig(configPath).catch((error: unknown) => {
  if (error instanceof UsersConfigError) {
    console.error(
      `[users-config] ${error.code}: ${error.message} (path=${error.path})`,
    );
  } else {
    console.error("[users-config] unexpected failure:", error);
  }
  process.exit(1);
});

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/users") {
      return getUsersHandler(config);
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`DockerDrop backend listening on http://127.0.0.1:${port}`);