import { describe, expect, it } from "bun:test";

import {
  ensureRecipientAllowed,
  findRecipient,
} from "../../../src/backend/config/recipient";
import { UnknownRecipientError } from "../../../src/backend/config/users.types";
import type { UsersConfig } from "../../../src/backend/config/users.types";

/**
 * Task 16.1 — RED stage.
 * `src/backend/config/recipient.ts` does not exist yet: every test below is expected
 * to fail (module resolution failure) until the module is implemented.
 *
 * Contract under test — pure functions over an in-memory `UsersConfig`:
 * - `findRecipient(config, recipientUserId): ColleagueUser | null`
 * - `ensureRecipientAllowed(config, recipientUserId): ColleagueUser`
 *   which throws `UnknownRecipientError` when the recipient is absent.
 *
 * These primitives are what `POST /transfers` reuses (task 16.4) to refuse a
 * recipient that is not part of the allowed colleagues configuration.
 */

const knownConfig: UsersConfig = {
  items: [
    { id: "mael", display_name: "Maël" },
    { id: "thomas", display_name: "Thomas" },
  ],
};
const emptyConfig: UsersConfig = { items: [] };

/** Runs `run` and returns whatever it threw; fails loudly when it returned normally. */
function captureThrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it returned normally.");
}

describe("findRecipient", () => {
  it("returns the exact configured colleague for a known id", () => {
    expect(findRecipient(knownConfig, "thomas")).toEqual({
      id: "thomas",
      display_name: "Thomas",
    });
    expect(findRecipient(knownConfig, "mael")).toEqual({
      id: "mael",
      display_name: "Maël",
    });
  });

  it("returns null for an id absent from the configuration", () => {
    expect(findRecipient(knownConfig, "inconnu")).toBeNull();
  });

  it("matches ids exactly: case-sensitive and no prefix match", () => {
    expect(findRecipient(knownConfig, "Thomas")).toBeNull();
    expect(findRecipient(knownConfig, "thoma")).toBeNull();
  });

  it("returns null for every recipient when the configuration is empty", () => {
    expect(findRecipient(emptyConfig, "thomas")).toBeNull();
    expect(findRecipient(emptyConfig, "mael")).toBeNull();
    expect(findRecipient(emptyConfig, "inconnu")).toBeNull();
  });
});

describe("ensureRecipientAllowed", () => {
  it("returns the matching colleague for an allowed recipient, without throwing", () => {
    expect(ensureRecipientAllowed(knownConfig, "mael")).toEqual({
      id: "mael",
      display_name: "Maël",
    });
  });

  it("throws UnknownRecipientError carrying the rejected id for an unknown recipient", () => {
    expect(() => ensureRecipientAllowed(knownConfig, "inconnu")).toThrow(
      UnknownRecipientError,
    );

    const error = captureThrown(() => ensureRecipientAllowed(knownConfig, "inconnu"));

    expect(error).toBeInstanceOf(UnknownRecipientError);
    expect((error as UnknownRecipientError).recipientUserId).toBe("inconnu");
    expect((error as UnknownRecipientError).message).toContain("inconnu");
  });

  it("refuses ids that only differ by case or by a missing character", () => {
    for (const candidate of ["Thomas", "thoma"]) {
      expect(() => ensureRecipientAllowed(knownConfig, candidate)).toThrow(
        UnknownRecipientError,
      );

      const error = captureThrown(() =>
        ensureRecipientAllowed(knownConfig, candidate),
      ) as UnknownRecipientError;

      expect(error).toBeInstanceOf(UnknownRecipientError);
      expect(error.recipientUserId).toBe(candidate);
    }
  });

  it("refuses every recipient when the configuration is empty", () => {
    for (const candidate of ["mael", "thomas", "inconnu"]) {
      const error = captureThrown(() =>
        ensureRecipientAllowed(emptyConfig, candidate),
      ) as UnknownRecipientError;

      expect(error).toBeInstanceOf(UnknownRecipientError);
      expect(error.recipientUserId).toBe(candidate);
    }
  });
});
