import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readCollection } from "../src/reader.js";
import { validateCollection } from "../src/validator.js";
import { writeCollection } from "../src/writer.js";

describe("writeCollection + validateCollection", () => {
  it("TV-COLL-002: round-trip write then read preserves structure", async () => {
    const fixture = path.resolve(__dirname, "fixtures/test-collection");
    const source = await readCollection(fixture);

    const outDir = await mkdtemp(path.join(tmpdir(), "apifn-collection-"));
    const toWrite = { ...source, rootDir: outDir };

    await writeCollection(toWrite);
    const roundTripped = await readCollection(outDir);

    expect(roundTripped.info).toEqual(source.info);
    expect(roundTripped.environments).toEqual(source.environments);
    expect(roundTripped.items).toEqual(source.items);
  });

  it("TV-COLL-003: valid collection returns empty validation errors", async () => {
    const fixture = path.resolve(__dirname, "fixtures/test-collection");
    const collection = await readCollection(fixture);

    expect(validateCollection(collection)).toEqual([]);
  });

  it("TV-COLL-003: invalid request/env produce validation errors with paths", async () => {
    const fixture = path.resolve(__dirname, "fixtures/test-collection");
    const collection = await readCollection(fixture);

    collection.environments.development = {
      name: "development",
      variables: undefined as unknown as Record<string, string>,
    };

    const usersFolder = collection.items.find((item) => item.name === "Users");
    if (!usersFolder || usersFolder.kind !== "folder" || !usersFolder.children?.[0]) {
      throw new Error("Fixture structure mismatch");
    }

    usersFolder.children[0].request = {
      ...usersFolder.children[0].request!,
      http: {
        ...usersFolder.children[0].request!.http,
        method: "",
      },
    };

    const errors = validateCollection(collection);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((error) => error.path.includes("request.http.method"))).toBe(true);
    expect(errors.some((error) => error.path.includes("environments.development.variables"))).toBe(
      true
    );
  });
});
