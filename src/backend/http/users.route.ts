import type { UsersConfig } from "../config/users.types";

/**
 * Builds the `GET /users` response exposing the configured colleagues.
 *
 * Only `{ items: [{ id, display_name }] }` is exposed: each item is rebuilt
 * explicitly so no other key from the configuration file (`name`, paths,
 * metadata) can leak. Configuration order is preserved.
 */
export function getUsersHandler(config: UsersConfig): Response {
  const items = config.items.map((user) => ({
    id: user.id,
    display_name: user.display_name,
  }));

  return new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
