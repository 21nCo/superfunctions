import { it, expect } from "vitest";
import { VitestAdapter } from "../src/integrations/vitest-adapter.js";
import { PlaywrightAdapter } from "../src/integrations/playwright-adapter.js";
const test = { id: "file", name: "file", file: "test.ts" };
class VitestProbe extends VitestAdapter {
  read(text: string) {
    return this.parse(text, test);
  }
}
class PlaywrightProbe extends PlaywrightAdapter {
  read(text: string) {
    return this.parse(text, test);
  }
}
it("normalizes all individual assertions including skip/failure details", () => {
  const results = new VitestProbe().read(
    JSON.stringify({
      testResults: [
        {
          assertionResults: [
            { fullName: "suite pass", status: "passed", duration: 2 },
            {
              fullName: "suite fail",
              status: "failed",
              failureMessages: ["expected 1"],
            },
            { fullName: "suite skip", status: "pending" },
          ],
        },
      ],
    }),
  );
  expect(results.map((r) => r.status)).toEqual(["passed", "failed", "skipped"]);
  expect(results[1].error?.message).toBe("expected 1");
  expect(results[0].id).toBe("test.ts > suite pass");
});
it("preserves browser identities, expected failures and attachments", () => {
  const results = new PlaywrightProbe().read(
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "check",
              tests: [
                {
                  projectName: "chromium",
                  status: "expected",
                  results: [{ status: "failed", duration: 3 }],
                },
                {
                  projectName: "firefox",
                  status: "unexpected",
                  results: [
                    {
                      status: "timedOut",
                      duration: 4,
                      error: { message: "timeout" },
                      attachments: [
                        {
                          name: "screen",
                          contentType: "image/png",
                          path: "screen.png",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(results).toHaveLength(2);
  expect(results[0].status).toBe("passed");
  expect(results[1].status).toBe("timeout");
  expect(results[1].id).toContain("firefox");
  expect(results[1].artifacts?.[0].type).toBe("screenshot");
});
