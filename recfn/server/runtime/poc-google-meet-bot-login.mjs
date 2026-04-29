import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname);
const profilesRoot = path.join(runtimeRoot, ".profiles");

function sanitizeProfileName(value) {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return trimmed || "default";
}

async function pathExists(candidate) {
  if (!candidate) {
    return false;
  }

  try {
    await fs.access(candidate, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveChromeExecutable() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "Google Chrome or Chromium was not found. Install Chrome or set CHROME_EXECUTABLE_PATH.",
  );
}

function resolveProfileDirectory() {
  if (process.env.RECFN_BOT_PROFILE_DIR?.trim()) {
    return path.resolve(process.env.RECFN_BOT_PROFILE_DIR.trim());
  }

  return path.join(
    profilesRoot,
    sanitizeProfileName(process.env.RECFN_BOT_PROFILE_NAME ?? "default"),
  );
}

async function main() {
  const executablePath = await resolveChromeExecutable();
  const userDataDir = resolveProfileDirectory();
  const loginURL = process.env.RECFN_BOT_LOGIN_URL ?? "https://accounts.google.com/";

  await fs.mkdir(userDataDir, { recursive: true });

  console.log(
    JSON.stringify({
      level: "info",
      event: "recfn.poc_google_meet_login.started",
      userDataDir,
      loginURL,
      timestamp: new Date().toISOString(),
    }),
  );
  console.log(
    "Sign into the dedicated bot Google account in the opened browser window. When the account is ready, close the browser window.",
  );

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath,
    viewport: null,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(loginURL, { waitUntil: "domcontentloaded" });
  await page.bringToFront().catch(() => {});

  await new Promise((resolve) => {
    context.once("close", resolve);
  });

  console.log(
    JSON.stringify({
      level: "info",
      event: "recfn.poc_google_meet_login.finished",
      userDataDir,
      timestamp: new Date().toISOString(),
    }),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "recfn.poc_google_meet_login.failed",
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }),
  );
  process.exit(1);
});
