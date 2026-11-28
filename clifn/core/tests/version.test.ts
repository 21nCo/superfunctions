import { compareVersions, parseVersion } from "../src/version.js";

describe("version grammar and SemVer 2.0.0 precedence (D13)", () => {
  // SemVer 2.0.0 section 11: 1.0.0 < 2.0.0 < 2.1.0 < 2.1.1, and
  // 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0.
  it.each<[string, string, number]>([
    ["1.0.0", "2.0.0", -1],
    ["2.0.0", "2.1.0", -1],
    ["2.1.0", "2.1.1", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta", -1],
    ["1.0.0-alpha.beta", "1.0.0-beta", -1],
    ["1.0.0-beta", "1.0.0-beta.2", -1],
    ["1.0.0-beta.2", "1.0.0-beta.11", -1],
    ["1.0.0-beta.11", "1.0.0-rc.1", -1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["2.1.1", "2.1.0", 1],
    ["1.9.0", "1.10.0", -1],
    ["1.2.3", "1.2.3", 0],
    ["1.0.0+build.1", "1.0.0+build.2", 0],
    ["1.0.0-alpha+001", "1.0.0-alpha", 0],
    ["1.0.0-a-b", "1.0.0-a", 1],
    ["1.0.0-1a", "1.0.0-9", 1],
    ["1.0.0-x.7.z.92", "1.0.0-x.7.z.92", 0],
    ["99999999999999999999.0.0", "99999999999999999998.0.0", 1],
  ])("%s vs %s -> %i", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
  });

  it.each([
    "1.2",
    "v1.2.3",
    "1.2.3.4",
    "",
    " 1.2.3",
    "1.2.3 ",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2.3-",
    "1.2.3-01",
    "1.2.3-a..b",
    "1.2.3-a_b",
    "1.2.3+",
    "1.2.3+a..b",
    "1.2.3\n",
    "1.2.3-\u001b[31m",
    `1.2.3-${"a".repeat(260)}`,
  ])("rejects %j", (text) => {
    expect(parseVersion(text)).toBeNull();
    expect(compareVersions(text, "1.0.0")).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseVersion(undefined)).toBeNull();
    expect(parseVersion(123)).toBeNull();
    expect(parseVersion({ toString: () => "1.2.3" })).toBeNull();
  });

  it("splits prerelease identifiers and drops build metadata", () => {
    expect(parseVersion("1.2.3-rc.1+sha.abc")).toEqual({ major: "1", minor: "2", patch: "3", prerelease: ["rc", "1"] });
    expect(parseVersion("0.0.0")).toEqual({ major: "0", minor: "0", patch: "0", prerelease: [] });
  });
});
