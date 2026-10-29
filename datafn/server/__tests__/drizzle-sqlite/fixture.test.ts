import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateDrizzleSchema } from "@datafn/cli";
import { conformanceSchema, legacyJsonUpgradeSql } from "./fixture.js";

describe("Drizzle SQLite conformance fixture", () => {
  it("matches the current @datafn/cli sqlite codegen output", () => {
    const source = readFileSync(new URL("./fixture.ts", import.meta.url), "utf8");
    const checkedIn = source.slice(
      source.indexOf("\n", source.indexOf("// BEGIN GENERATED")) + 1,
      source.indexOf("// END GENERATED"),
    );
    const generated = generateDrizzleSchema(conformanceSchema, "sqlite");
    const body = generated.slice(generated.indexOf("\n", generated.indexOf("// Database: sqlite")) + 1);
    expect(checkedIn.trim()).toBe(body.trim());
  });

  it("runs the JSON column upgrade the codegen docs give", () => {
    const docs = readFileSync(new URL("../../../docs/content/docs/cli/drizzle-codegen.mdx", import.meta.url), "utf8");
    expect(docs).toContain(legacyJsonUpgradeSql);
  });
});
