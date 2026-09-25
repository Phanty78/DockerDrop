/**
 * Task 16.1 — loads the colleagues configuration file (architecture §11).
 * File shape: `[{ "id": "mael", "name": "Maël" }]`, exposed as `{ items: [{ id, display_name }] }`.
 * Every failure is reported as a `UsersConfigError` carrying the requested path and a loggable message.
 */

import { UsersConfigError } from "./users.types";
import type { ColleagueUser, UsersConfig } from "./users.types";

/** True when reading failed because the file does not exist (vs. exists but cannot be read). */
function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ENOENT") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOENT") || message.includes("no such file");
}

/** Builds an `USERS_CONFIG_INVALID` error; `detail` explains what is wrong with the file content. */
function invalidConfig(path: string, detail: string): UsersConfigError {
  return new UsersConfigError(
    "USERS_CONFIG_INVALID",
    path,
    `Users configuration file is invalid: ${path} (${detail})`,
  );
}

/** Validates the parsed JSON document; ids/names are trimmed, `name` mapped to `display_name`, file order preserved. */
function parseUsersConfig(parsed: unknown, path: string): UsersConfig {
  if (!Array.isArray(parsed)) {
    throw invalidConfig(path, "expected a JSON array of colleagues");
  }

  const items: ColleagueUser[] = [];
  const seenIds = new Set<string>();

  for (const [index, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null) {
      throw invalidConfig(path, `entry #${index} must be an object`);
    }

    const { id, name } = entry as { id?: unknown; name?: unknown };

    if (typeof id !== "string" || id.trim() === "") {
      throw invalidConfig(path, `entry #${index} must have a non-empty string "id"`);
    }
    const trimmedId = id.trim();
    if (typeof name !== "string" || name.trim() === "") {
      throw invalidConfig(path, `entry #${index} (id "${trimmedId}") must have a non-empty string "name"`);
    }
    if (seenIds.has(trimmedId)) {
      throw invalidConfig(path, `entry #${index} repeats the id "${trimmedId}"`);
    }

    seenIds.add(trimmedId);
    items.push({ id: trimmedId, display_name: name.trim() });
  }

  return { items };
}

/**
 * Loads the colleagues configuration from `path`.
 * Throws `UsersConfigError` with code `USERS_CONFIG_MISSING` (absent file),
 * `USERS_CONFIG_UNREADABLE` (present but not readable) or `USERS_CONFIG_INVALID`
 * (malformed JSON or entries violating the contract).
 */
export async function loadUsersConfig(path: string): Promise<UsersConfig> {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new UsersConfigError(
        "USERS_CONFIG_MISSING",
        path,
        `Users configuration file is missing: ${path}`,
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    throw new UsersConfigError(
      "USERS_CONFIG_UNREADABLE",
      path,
      `Users configuration file cannot be read: ${path} (${cause})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw invalidConfig(path, `not valid JSON: ${cause}`);
  }

  return parseUsersConfig(parsed, path);
}
