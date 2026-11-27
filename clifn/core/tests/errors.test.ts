import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore, MissingProfileError } from "../src/credentials.js";
import { classifyRunnerError, RUNNER_FAILED_CODE } from "../src/errors.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("classifyRunnerError", () => {
  it("uses an explicit code that matches the code pattern, with the error's message", () => {
    const error = Object.assign(new Error("Ada is unavailable"), { code: "STATUS_UNAVAILABLE" });
    expect(classifyRunnerError(error)).toEqual({
      error: { code: "STATUS_UNAVAILABLE", message: "Ada is unavailable" },
      exitCode: 1,
    });
  });

  it.each(["lower_case", "X", "1STARTS_WITH_DIGIT", "HAS-DASH", `A${"B".repeat(64)}`, 42])(
    "ignores the code %s, which does not match the code pattern",
    (code) => {
      expect(classifyRunnerError(Object.assign(new Error("boom"), { code })).error).toEqual({
        code: RUNNER_FAILED_CODE,
        message: "boom",
      });
    }
  );

  it("maps MissingProfileError from the credential store to CLIFN_MISSING_PROFILE", () => {
    const directory = mkdtempSync(join(tmpdir(), "clifn-errors-"));
    directories.push(directory);
    const store = createCredentialStore({ path: join(directory, "credentials") });
    const error = capture(() => store.getProfile("missing"));

    expect(error).toBeInstanceOf(MissingProfileError);
    expect(classifyRunnerError(error)).toEqual({
      error: { code: "CLIFN_MISSING_PROFILE", message: (error as Error).message },
      exitCode: 1,
    });
  });

  it("maps a busy credential store to CLIFN_CREDENTIAL_STORE_BUSY with its fixed description", () => {
    const directory = mkdtempSync(join(tmpdir(), "clifn-errors-"));
    directories.push(directory);
    const path = join(directory, "credentials");
    writeFileSync(`${path}.lock`, "");
    const error = capture(() => createCredentialStore({ path }).setProfile("default", { region: "test-region" }));

    expect((error as Error).message).toBe("CLIFN_CREDENTIAL_STORE_BUSY");
    expect(classifyRunnerError(error)).toEqual({
      error: {
        code: "CLIFN_CREDENTIAL_STORE_BUSY",
        message: "The credential store is locked by another writer; try again when it has finished.",
      },
      exitCode: 1,
    });
  });

  it("gives an exact CLIFN_ message without a table entry a generic description", () => {
    expect(classifyRunnerError(new Error("CLIFN_SOMETHING_NEW")).error).toEqual({
      code: "CLIFN_SOMETHING_NEW",
      message: "The operation failed.",
    });
  });

  it("prefers an explicit code over a CLIFN_ message", () => {
    const error = Object.assign(new Error("CLIFN_CREDENTIAL_STORE_BUSY"), { code: "EXPLICIT_CODE" });
    expect(classifyRunnerError(error).error).toEqual({ code: "EXPLICIT_CODE", message: "CLIFN_CREDENTIAL_STORE_BUSY" });
  });

  it.each([
    ["a message that only contains a CLIFN_ code", new Error("failed: CLIFN_CREDENTIAL_STORE_BUSY"), "failed: CLIFN_CREDENTIAL_STORE_BUSY"],
    ["a plain Error", new Error("boom"), "boom"],
    ["an Error with an empty message", new TypeError(""), "TypeError"],
    ["a thrown string", "plain failure", "plain failure"],
    ["a thrown number", 42, "Unknown runner failure"],
    ["undefined", undefined, "Unknown runner failure"],
  ])("falls back to CLIFN_RUNNER_FAILED for %s", (_label, thrown, message) => {
    expect(classifyRunnerError(thrown)).toEqual({ error: { code: RUNNER_FAILED_CODE, message }, exitCode: 1 });
  });

  it("falls back when reading the thrown value throws", () => {
    const thrown = new Proxy(new Error("boom"), {
      get() {
        throw new Error("trap");
      },
    });
    expect(classifyRunnerError(thrown)).toEqual({
      error: { code: RUNNER_FAILED_CODE, message: "Unknown runner failure" },
      exitCode: 1,
    });
  });

  it.each([
    [3, 3],
    [1, 1],
    [125, 125],
    [300, 1],
    [0, 1],
    [1.5, 1],
    [126, 1],
    [-2, 1],
    ["3", 1],
    [undefined, 1],
  ])("maps exitCode %s to exit code %s", (exitCode, expected) => {
    expect(classifyRunnerError(Object.assign(new Error("boom"), { exitCode })).exitCode).toBe(expected);
  });
});
