import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { testFn, TestStorage } from "../typescript/dist/index.js";
const root = fileURLToPath(new URL("../typescript/", import.meta.url));
await mkdir(join(root, ".conduct"), { recursive: true });
const directory = await mkdtemp(join(root, ".conduct/framework-"));
const original = process.cwd();
process.chdir(directory);
let assertions = 0;
const check = (value, message) => {
  assert(value, message);
  assertions++;
};
try {
  await writeFile("package.json", JSON.stringify({ type: "module" }));
  await writeFile(
    "vitest.config.mjs",
    `export default {test:{include:['*.vitest.test.js'],maxWorkers:1}}`,
  );
  await writeFile(
    "sample.vitest.test.js",
    `import {test,expect} from 'vitest';test('passes env',()=>expect(process.env.TESTFN_ENV).toBe('set'));test('fails',()=>expect(1).toBe(2));test.skip('skipped',()=>{});`,
  );
  await writeFile(
    "jest.config.cjs",
    `module.exports={testMatch:['**/*.jest.test.cjs']};`,
  );
  await writeFile(
    "sample.jest.test.cjs",
    `test('passes env',()=>expect(process.env.TESTFN_ENV).toBe('set'));test('fails',()=>expect(1).toBe(2));test.skip('skipped',()=>{});`,
  );
  for (const framework of ["vitest", "jest"]) {
    const run = await testFn({
      framework,
      testPattern: `sample.${framework}.test.${framework === "jest" ? "cjs" : "js"}`,
      env: { TESTFN_ENV: "set" },
      timeout: 30000,
      reporters: [],
      storage: { type: "file", dbName: "results" },
    }).run();
    check(run.summary.total === 3, `${framework}: ${JSON.stringify(run)}`);
    check(
      run.summary.passed === 1 &&
        run.summary.failed === 1 &&
        run.summary.skipped === 1,
      `${framework} statuses`,
    );
    const storage = new TestStorage({ type: "file", dbName: "results" });
    await storage.open();
    check(
      (await storage.getRun(run.id)).results.length === 3,
      "persisted actual assertions",
    );
    await storage.close();
  }
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const executable =
    process.env.BROWSER_EXECUTABLE_PATH ??
    (existsSync(chrome) ? chrome : undefined);
  const browsers = (
    process.env.TESTFN_BROWSERS ?? "chromium,firefox,webkit"
  ).split(",");
  await writeFile(
    "playwright.config.mjs",
    `export default {projects:[{name:'chromium',use:{launchOptions:{executablePath:${JSON.stringify(executable)}}}}]};`,
  );
  await writeFile(
    "browser.spec.js",
    `import {test,expect} from '@playwright/test';test('real DOM',async({page,browserName})=>{if(browserName==='chromium'){expect(page.viewportSize().width).toBe(390);expect(await page.evaluate(()=>navigator.userAgent)).toBe('testfn-mobile');expect(await page.evaluate(()=>navigator.maxTouchPoints)).toBeGreaterThan(0);}await page.setContent('<button>ready</button>');await expect(page.getByRole('button')).toHaveText('ready');});test('expected failure',async()=>{test.fail();expect(1).toBe(2)});test.skip('skipped',()=>{});`,
  );
  const playwright = await testFn({
    framework: "playwright",
    testPattern: "browser.spec.js",
    browsers: browsers.map((name) =>
      name === "chromium"
        ? {
            name,
            viewport: { width: 390, height: 844 },
            userAgent: "testfn-mobile",
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 3,
          }
        : { name },
    ),
    timeout: 30000,
    reporters: [],
  }).run();
  check(
    playwright.summary.total === 3 * browsers.length,
    JSON.stringify(playwright),
  );
  check(
    playwright.summary.passed === 2 * browsers.length &&
      playwright.summary.skipped === browsers.length,
    JSON.stringify(playwright),
  );
  await writeFile(
    "browser.puppeteer.test.mjs",
    `import {test} from 'node:test';import assert from 'node:assert/strict';import puppeteer from 'puppeteer';test('real browser',async()=>{const browser=await puppeteer.launch({executablePath:${JSON.stringify(executable)},headless:true});try{const page=await browser.newPage();await page.setContent('<h1>ready</h1>');assert.equal(await page.$eval('h1',e=>e.textContent),'ready');}finally{await browser.close()}});test.skip('skip',()=>{});`,
  );
  const puppeteer = await testFn({
    framework: "puppeteer",
    testPattern: "browser.puppeteer.test.mjs",
    timeout: 30000,
    reporters: [],
  }).run();
  check(
    puppeteer.summary.total === 2 &&
      puppeteer.summary.passed === 1 &&
      puppeteer.summary.skipped === 1,
    JSON.stringify(puppeteer),
  );
  console.log(
    JSON.stringify({
      assertions,
      frameworks: [
        "vitest",
        "jest",
        `playwright/${browsers.join("+")}`,
        "puppeteer/chromium",
      ],
    }),
  );
} finally {
  process.chdir(original);
  await rm(directory, { recursive: true, force: true });
}
