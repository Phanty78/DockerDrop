import { describe, expect, it } from "bun:test";

import type { UsersConfig } from "../../../src/backend/config/users.types";
import { getUsersHandler } from "../../../src/backend/http/users.route";

/**
 * Contract under test: `getUsersHandler(config: UsersConfig): Response`
 * exposes ONLY `{ items: [{ id, display_name }] }`.
 */

/** Shape intentionally loose: the assertions must be able to detect leaked keys. */
interface UsersResponseBody {
  items: Array<Record<string, unknown>>;
}

describe("getUsersHandler", () => {
  it("returns a 200 JSON response with the two configured colleagues and no extra field", async () => {
    const config: UsersConfig = {
      items: [
        { id: "mael", display_name: "Maël" },
        { id: "thomas", display_name: "Thomas" },
      ],
    };

    const response = getUsersHandler(config);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as UsersResponseBody;

    expect(body).toEqual({
      items: [
        { id: "mael", display_name: "Maël" },
        { id: "thomas", display_name: "Thomas" },
      ],
    });

    // No extra top-level metadata, no file path, no technical field.
    expect(Object.keys(body)).toEqual(["items"]);
    // Each item exposes exactly `id` and `display_name` (the config file `name` must not leak).
    expect(body.items.map((item) => Object.keys(item).sort())).toEqual([
      ["display_name", "id"],
      ["display_name", "id"],
    ]);
  });

  it("returns the single configured colleague", async () => {
    const config: UsersConfig = { items: [{ id: "sophie", display_name: "Sophie" }] };

    const response = getUsersHandler(config);

    expect(response.status).toBe(200);

    const body = (await response.json()) as UsersResponseBody;

    expect(body).toEqual({ items: [{ id: "sophie", display_name: "Sophie" }] });
    expect(Object.keys(body)).toEqual(["items"]);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["display_name", "id"]);
  });

  it("returns an empty items array for an empty configuration", async () => {
    const config: UsersConfig = { items: [] };

    const response = getUsersHandler(config);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");

    const body = (await response.json()) as UsersResponseBody;

    expect(body).toEqual({ items: [] });
    expect(Object.keys(body)).toEqual(["items"]);
  });

  it("preserves the configuration order of the colleagues", async () => {
    const config: UsersConfig = {
      items: [
        { id: "thomas", display_name: "Thomas" },
        { id: "sophie", display_name: "Sophie" },
        { id: "mael", display_name: "Maël" },
      ],
    };

    const response = getUsersHandler(config);

    expect(response.status).toBe(200);

    const body = (await response.json()) as UsersResponseBody;

    expect(body.items.map((item) => item.id)).toEqual(["thomas", "sophie", "mael"]);
    expect(body).toEqual({
      items: [
        { id: "thomas", display_name: "Thomas" },
        { id: "sophie", display_name: "Sophie" },
        { id: "mael", display_name: "Maël" },
      ],
    });
  });
});
