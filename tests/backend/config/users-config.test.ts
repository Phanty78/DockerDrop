import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadUsersConfig } from "../../../src/backend/config/users";
import {
  UsersConfigError,
  type UsersConfigErrorCode,
} from "../../../src/backend/config/users.types";

/** `tests/fixtures/users`, resolved from this file so the cwd never matters. */
const FIXTURES_DIR = join(import.meta.dir, "..", "..", "fixtures", "users");

/** No fixture and no test writes that name: the file is guaranteed to be absent. */
const MISSING_CONFIG_PATH = join(FIXTURES_DIR, "users-config-that-does-not-exist.json");

const temporaryDirectories: string[] = [];
const permissionPatchedFiles: string[] = [];

afterEach(async () => {
  for (const file of permissionPatchedFiles.splice(0)) {
    await chmod(file, 0o644).catch(() => undefined);
  }
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Writes a readable copy of `valid.json` in a throwaway directory, then strips
 * every permission bit so that reading it fails.
 */
async function createUnreadableConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "dockerdrop-users-config-"));
  temporaryDirectories.push(directory);

  const path = join(directory, "users.json");
  await writeFile(path, await readFile(join(FIXTURES_DIR, "valid.json"), "utf8"), "utf8");
  await chmod(path, 0o000);
  permissionPatchedFiles.push(path);

  return path;
}

async function isReadable(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Asserts that `loadUsersConfig(path)` rejects with a `UsersConfigError` carrying
 * the expected code, the requested path and a non-empty, loggable message.
 */
async function captureUsersConfigError(
  path: string,
  expectedCode: UsersConfigErrorCode,
): Promise<UsersConfigError> {
  let caught: unknown;
  try {
    await loadUsersConfig(path);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(UsersConfigError);

  const error = caught as UsersConfigError;
  expect(error.code).toBe(expectedCode);
  expect(error.path).toBe(path);
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.message).toContain(path);

  return error;
}

describe("loadUsersConfig", () => {
  describe("config valide", () => {
    it("résout les collègues dans l'ordre du fichier et mappe name vers display_name", async () => {
      const config = await loadUsersConfig(join(FIXTURES_DIR, "valid.json"));

      expect(config.items).toHaveLength(2);
      expect(config.items.map((item) => item.id)).toEqual(["mael", "thomas"]);
      expect(config.items.map((item) => item.display_name)).toEqual(["Maël", "Thomas"]);
      expect(config.items).toEqual([
        { id: "mael", display_name: "Maël" },
        { id: "thomas", display_name: "Thomas" },
      ]);
    });
  });

  describe("fichier absent", () => {
    it("rejette USERS_CONFIG_MISSING en conservant le chemin demandé", async () => {
      await captureUsersConfigError(MISSING_CONFIG_PATH, "USERS_CONFIG_MISSING");
    });
  });

  describe("fichier illisible", () => {
    it("rejette USERS_CONFIG_UNREADABLE quand le fichier ne peut pas être lu", async () => {
      const path = await createUnreadableConfig();

      if (await isReadable(path)) {
        // A privileged user (or a filesystem ignoring permission bits) keeps read
        // access after chmod 000: the scenario cannot be reproduced here.
        console.warn(
          `[users-config] ${path} reste lisible après chmod 000 (utilisateur privilégié ?) : cas USERS_CONFIG_UNREADABLE non vérifié.`,
        );
        return;
      }

      await captureUsersConfigError(path, "USERS_CONFIG_UNREADABLE");
    });
  });

  describe("config invalide", () => {
    const invalidFixtures = [
      "invalid-json.json",
      "invalid-shape-not-array.json",
      "invalid-missing-name.json",
      "invalid-empty-id.json",
      "invalid-duplicate-ids.json",
    ] as const;

    for (const name of invalidFixtures) {
      it(`rejette USERS_CONFIG_INVALID pour ${name}`, async () => {
        await captureUsersConfigError(join(FIXTURES_DIR, name), "USERS_CONFIG_INVALID");
      });
    }
  });
});
