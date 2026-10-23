import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { JsonReporter } from "../src/reporters/json-reporter.js";
import { HtmlReporter } from "../src/reporters/html-reporter.js";
import { VisualTester } from "../src/visual/visual-tester.js";
const summary = { total: 1, passed: 0, failed: 1, skipped: 0, duration: 5 };
it("JSON and HTML reports contain actual results and reset between runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testfn-report-"));
  try {
    for (const extension of ["json", "html"]) {
      const path = join(dir, "nested", `report.${extension}`);
      const reporter =
        extension === "json" ? new JsonReporter(path) : new HtmlReporter(path);
      reporter.onRunStart();
      reporter.onTestComplete({
        id: "<script>bad</script>",
        status: "failed",
        duration: 5,
        error: { message: "<b>failure</b>" },
        artifacts: [{ type: "log", path: "log.txt" }],
      });
      reporter.onRunComplete(summary);
      const text = await readFile(path, "utf8");
      if (extension === "json") {
        expect(JSON.parse(text).results).toHaveLength(1);
        expect(JSON.parse(text).artifacts[0].path).toBe("log.txt");
      } else {
        expect(text).toContain("&lt;script&gt;bad&lt;/script&gt;");
        expect(text).not.toContain("<script>bad</script>");
      }
      reporter.onRunStart();
      reporter.onRunComplete({ ...summary, total: 0, failed: 0 });
      const next = await readFile(path, "utf8");
      expect(next).not.toContain("bad");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
const png = (red: number) => {
  const image = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = red;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
};
it("supports exact comparison, baseline replacement and clearing obsolete diffs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testfn-visual-"));
  try {
    const config = {
      baselineDir: join(dir, "base"),
      diffDir: join(dir, "diff"),
      threshold: 0,
    };
    const visual = new VisualTester(config);
    const black = await visual.captureScreenshot("screen", png(0)),
      red = await visual.captureScreenshot("screen", png(255));
    await visual.updateBaseline("nested/screen", black);
    expect(
      (await visual.compareScreenshot(black, "nested/screen")).passed,
    ).toBe(true);
    expect((await visual.compareScreenshot(red, "nested/screen")).passed).toBe(
      false,
    );
    expect(await visual.getDiff("nested/screen")).not.toBeNull();
    await visual.compareScreenshot(black, "nested/screen");
    expect(await visual.getDiff("nested/screen")).toBeNull();
    const update = new VisualTester({ ...config, updateBaselines: true });
    await update.compareScreenshot(red, "nested/screen");
    expect((await visual.compareScreenshot(red, "nested/screen")).passed).toBe(
      true,
    );
    await expect(
      visual.updateBaseline("../../escape", black),
    ).rejects.toThrow();
    await expect(visual.getDiff("/tmp/escape")).rejects.toThrow();
    expect(() => new VisualTester({ ...config, threshold: -1 })).toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
