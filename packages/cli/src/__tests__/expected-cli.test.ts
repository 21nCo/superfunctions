import { describe, expect, it } from "vitest";
import { expectedCliMismatch } from "../utils/expected-cli.js";

const pkg = { name: "@superfunctions/cli", version: "0.2.3" };

describe("expectedCliMismatch", () => {
  it("passes and clears a matching expectation", () => {
    const env: NodeJS.ProcessEnv = { BARE_EXPECTED_CLI: "@superfunctions/cli@0.2.3" };
    expect(expectedCliMismatch(pkg, env)).toBeUndefined();
    expect(env.BARE_EXPECTED_CLI).toBeUndefined();
  });

  it("refuses another version of this CLI", () => {
    const env: NodeJS.ProcessEnv = { BARE_EXPECTED_CLI: "@superfunctions/cli@0.2.4" };
    expect(expectedCliMismatch(pkg, env)).toBe(
      "expected @superfunctions/cli 0.2.4, found 0.2.3; run npx @superfunctions/cli@0.2.4"
    );
  });

  it("ignores an expectation for another package, and no expectation", () => {
    const env: NodeJS.ProcessEnv = { BARE_EXPECTED_CLI: "@superfunctions/reviewfn-cli@0.1.2" };
    expect(expectedCliMismatch(pkg, env)).toBeUndefined();
    expect(env.BARE_EXPECTED_CLI).toBe("@superfunctions/reviewfn-cli@0.1.2");
    expect(expectedCliMismatch(pkg, {})).toBeUndefined();
  });
});
