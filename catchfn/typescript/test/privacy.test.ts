import { describe, expect, it } from "vitest";
import { redactObject, redactUrl } from "../src/utils/redaction.js";

// The closed set of URL forms from the SFNS-56 scope amendment.
const RELATIVE = [
  "/api?TOKEN=relative-secret&ok=1",
  "../api?token=relative-secret",
  "?%74oken=relative-secret",
  "//user:relative-secret@example.com/api?key=relative-secret",
  "/api#access_token=relative-secret",
  "/api#%74oken=relative-secret",
  "/api#token%=relative-secret",
  "https://user:relative-secret@[invalid/?token=relative-secret",
];

function bothForms(url: string): string[] {
  return [redactUrl(url), redactObject({ networkLogs: [{ url }] }).networkLogs[0].url];
}

describe("URL privacy closed set", () => {
  it.each(RELATIVE)("scrubs %s without inventing an origin", (url) => {
    for (const output of bothForms(url)) {
      expect(output).not.toContain("relative-secret");
      expect(output).not.toContain("catchfn.invalid");
    }
  });

  it("keeps the non-secret parts of a relative URL", () => {
    expect(redactUrl("/api?TOKEN=relative-secret&ok=1")).toMatch(/^\/api\?TOKEN=.+&ok=1$/);
    expect(redactUrl("//user:relative-secret@example.com/api?key=relative-secret")).toMatch(/^\/\/example\.com\/api\?key=/);
    expect(redactUrl("https://user:relative-secret@[invalid/?token=relative-secret")).toBe("[REDACTED_URL]");
  });

  it("drops both the user and the password of an absolute URL", () => {
    for (const output of bothForms("https://user:pass@example.com/?TOKEN=secret")) {
      expect(output).not.toContain("user");
      expect(output).not.toContain("pass");
      expect(output).not.toContain("secret");
      expect(output).not.toContain("catchfn.invalid");
    }
  });

  it("redacts a token-bearing fragment of an absolute URL", () => {
    for (const output of bothForms("https://example.com/#access_token=secret")) {
      expect(output).not.toContain("secret");
      expect(output).toContain("https://example.com/");
    }
  });
});
