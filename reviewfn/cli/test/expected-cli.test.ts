import { describe, expect, it } from "vitest";
import { expectedCliMismatch } from "../src/expected-cli.js";

const pkg = { name: "@superfunctions/reviewfn-cli", version: "0.1.2" };

describe("expectedCliMismatch", () => {
  it("passes and clears a matching expectation", () => {
    const env: NodeJS.ProcessEnv = { BARE_EXPECTED_CLI: "@superfunctions/reviewfn-cli@0.1.2" };
    expect(expectedCliMismatch(pkg, env)).toBeUndefined();
    expect(env.BARE_EXPECTED_CLI).toBeUndefined();
  });

  it("refuses another version of this CLI", () => {
    expect(expectedCliMismatch(pkg, { BARE_EXPECTED_CLI: "@superfunctions/reviewfn-cli@0.1.3" })).toBe(
      "expected @superfunctions/reviewfn-cli 0.1.3, found 0.1.2; run npx @superfunctions/reviewfn-cli@0.1.3"
    );
  });

  it("ignores an expectation for another package, and no expectation", () => {
    const env: NodeJS.ProcessEnv = { BARE_EXPECTED_CLI: "@superfunctions/cli@0.2.3" };
    expect(expectedCliMismatch(pkg, env)).toBeUndefined();
    expect(env.BARE_EXPECTED_CLI).toBe("@superfunctions/cli@0.2.3");
    expect(expectedCliMismatch(pkg, {})).toBeUndefined();
  });
});
