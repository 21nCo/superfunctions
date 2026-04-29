import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname);
const profilesRoot = path.join(runtimeRoot, ".profiles");

let context;
let page;
let shuttingDown = false;
let userDataDir;
let deleteUserDataDirOnExit = false;
let diagnosticsDirectory;
let joinRequestSent = false;
let meetingJoined = false;
const configuredPages = new WeakSet();

function emit(type, payload = {}) {
  process.stdout.write(`${JSON.stringify({ type, ...payload })}\n`);
}

function emitStatus(stage, message) {
  emit("status", { stage, message });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeProfileName(value) {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return trimmed || "default";
}

function parseArguments() {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  if (configIndex === -1 || !args[configIndex + 1]) {
    throw new Error("Missing required --config argument.");
  }

  return {
    configPath: path.resolve(args[configIndex + 1]),
  };
}

async function readConfiguration(configPath) {
  const raw = await fs.readFile(configPath, "utf8");
  return JSON.parse(raw);
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

function resolveProfileDirectory(configuration) {
  if (typeof configuration.profileDirectory === "string" && configuration.profileDirectory.trim()) {
    return path.resolve(configuration.profileDirectory.trim());
  }

  return path.join(
    profilesRoot,
    sanitizeProfileName(configuration.profileName ?? process.env.RECFN_BOT_PROFILE_NAME ?? "default"),
  );
}

async function writeDiagnosticFile(name, content) {
  if (!diagnosticsDirectory) {
    return;
  }

  await fs.mkdir(diagnosticsDirectory, { recursive: true });
  await fs.writeFile(path.join(diagnosticsDirectory, name), content);
}

async function captureDiagnostics(reason) {
  if (!diagnosticsDirectory) {
    return;
  }

  await fs.mkdir(diagnosticsDirectory, { recursive: true });

  const pages = context?.pages?.() ?? [];
  const state = {
    reason,
    timestamp: new Date().toISOString(),
    activeURL: page && !page.isClosed() ? page.url() : null,
    activeTitle: null,
    pages: pages.map((candidate) => ({
      url: candidate.isClosed() ? "closed" : candidate.url(),
      isActive: candidate === page,
    })),
  };

  if (page && !page.isClosed()) {
    try {
      state.activeTitle = await page.title();
    } catch {
      state.activeTitle = null;
    }

    try {
      await page.screenshot({
        path: path.join(diagnosticsDirectory, "meet-page.png"),
        fullPage: true,
      });
    } catch {
      // Best effort only.
    }

    try {
      await writeDiagnosticFile("meet-page.html", await page.content());
    } catch {
      // Best effort only.
    }
  }

  await writeDiagnosticFile("page-state.json", `${JSON.stringify(state, null, 2)}\n`);
}

function configurePage(candidate) {
  if (!candidate || configuredPages.has(candidate)) {
    return;
  }

  configuredPages.add(candidate);
  candidate.setDefaultTimeout(20000);
  candidate.setDefaultNavigationTimeout(60000);

  candidate.on("pageerror", (error) => {
    emitStatus(
      meetingJoined ? "capturing" : "launchingBrowser",
      `Browser page error: ${error.message}`,
    );
  });

  candidate.on("dialog", async (dialog) => {
    try {
      await dialog.dismiss();
    } catch {
      // Ignore stray dialogs.
    }
  });

  candidate.on("close", async () => {
    if (shuttingDown || candidate !== page) {
      return;
    }

    await sleep(800);
    if (await activateMeetPageIfAvailable("Google Meet moved the bot flow into another tab. Continuing there.")) {
      return;
    }

    if (meetingJoined) {
      emitStatus("finished", "Meet bot window closed.");
      await closeResources(0);
      return;
    }

    const reason = joinRequestSent
      ? "The bot browser closed after sending the join request but before entering the meeting."
      : "The bot browser closed before it could send a Google Meet join request.";
    await captureDiagnostics(reason);
    emit("error", { message: reason });
    await closeResources(1);
  });

  candidate.on("framenavigated", async (frame) => {
    if (candidate !== page || frame !== candidate.mainFrame() || !meetingJoined) {
      return;
    }

    const currentURL = frame.url();
    if (!currentURL.includes("meet.google.com") && !currentURL.startsWith("about:blank")) {
      emitStatus("finished", "Bot navigated away from Google Meet.");
      await closeResources(0);
    }
  });
}

async function activateMeetPageIfAvailable(message) {
  if (!context) {
    return false;
  }

  const openPages = context.pages().filter((candidate) => !candidate.isClosed());
  const meetPage = openPages.find((candidate) => candidate.url().includes("meet.google.com"));
  const candidate = meetPage ?? openPages.at(-1);
  if (!candidate || candidate === page) {
    return Boolean(candidate);
  }

  page = candidate;
  configurePage(page);
  emitStatus(joinRequestSent ? "waitingForAdmission" : "launchingBrowser", message);
  return true;
}

async function launchBrowser(configuration) {
  const executablePath = await resolveChromeExecutable();
  userDataDir = resolveProfileDirectory(configuration);
  await fs.mkdir(userDataDir, { recursive: true });
  deleteUserDataDirOnExit = false;

  const headless = configuration.headless !== false;
  const launchArgs = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=DialMediaRouteProvider",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-notifications",
    "--mute-audio",
  ];
  if (!headless) {
    launchArgs.push("--start-minimized");
  }

  context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath,
    viewport: headless ? { width: 1440, height: 960 } : null,
    args: launchArgs,
  });

  await context.addInitScript(() => {
    const denyMedia = () =>
      Promise.reject(new DOMException("Passive notetaker blocks local media.", "NotAllowedError"));

    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: denyMedia,
      });
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: denyMedia,
      });
    }
  });

  context.on("page", async (newPage) => {
    configurePage(newPage);
    await sleep(500);
    if (newPage.isClosed()) {
      return;
    }

    if (newPage.url().includes("meet.google.com") || newPage.url() === "about:blank") {
      page = newPage;
      emitStatus("launchingBrowser", "Meet opened another bot tab. Continuing there.");
    }
  });

  page = context.pages()[0] ?? (await context.newPage());
  configurePage(page);
}

async function fillGuestNameIfNeeded(botDisplayName) {
  await page.waitForTimeout(1500);
  await page.evaluate((displayName) => {
    const inputSelectors = [
      'input[aria-label*="Your name"]',
      'input[placeholder*="Your name"]',
      'input[type="text"]',
    ];

    for (const selector of inputSelectors) {
      const input = document.querySelector(selector);
      if (input instanceof HTMLInputElement && !input.disabled) {
        input.focus();
        input.value = displayName;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
    }
  }, botDisplayName);
}

async function ensureMediaOff() {
  await page.evaluate(() => {
    const normalizeText = (value) => value.replace(/\s+/g, " ").trim();
    const buttonText = (button) =>
      normalizeText(
        [
          button.getAttribute("aria-label") ?? "",
          button.getAttribute("title") ?? "",
          button.getAttribute("data-tooltip") ?? "",
          button.innerText ?? "",
          button.textContent ?? "",
        ].join(" "),
      );

    const isVisible = (button) => {
      if (!(button instanceof HTMLElement)) {
        return false;
      }
      const rect = button.getBoundingClientRect();
      const style = window.getComputedStyle(button);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    const mediaOffPatterns = [
      /turn off microphone/i,
      /mute microphone/i,
      /turn off camera/i,
      /turn off video/i,
      /stop video/i,
    ];

    buttons.forEach((button) => {
      if (!isVisible(button)) {
        return;
      }

      const text = buttonText(button);
      if (mediaOffPatterns.some((pattern) => pattern.test(text))) {
        button.click();
      }
    });
  });
}

async function enforcePassiveMeetingState() {
  await page
    .evaluate(() => {
      const normalizeText = (value) => value.replace(/\s+/g, " ").trim();
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));

      const isVisible = (button) => {
        if (!(button instanceof HTMLElement)) {
          return false;
        }
        const rect = button.getBoundingClientRect();
        const style = window.getComputedStyle(button);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      };

      const labelFor = (button) =>
        normalizeText(
          [
            button.getAttribute("aria-label") ?? "",
            button.getAttribute("title") ?? "",
            button.getAttribute("data-tooltip") ?? "",
            button.innerText ?? "",
            button.textContent ?? "",
          ].join(" "),
        );

      const passivePatterns = [
        /turn off microphone/i,
        /mute microphone/i,
        /turn off camera/i,
        /turn off video/i,
        /stop video/i,
        /stop presenting/i,
        /stop sharing/i,
        /stop annotating/i,
      ];

      buttons.forEach((button) => {
        if (!isVisible(button)) {
          return;
        }

        const label = labelFor(button);
        if (passivePatterns.some((pattern) => pattern.test(label))) {
          button.click();
        }
      });
    })
    .catch(() => {});
}

async function clickVisibleButton(patterns) {
  const serializedPatterns = patterns.map((pattern) => ({
    source: pattern.source,
    flags: pattern.flags,
  }));

  return page.evaluate(({ entries }) => {
    const regexes = entries.map((entry) => new RegExp(entry.source, entry.flags));
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));

    const normalizeText = (value) => value.replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) {
        continue;
      }

      const text = normalizeText(
        [
          candidate.innerText ?? "",
          candidate.textContent ?? "",
          candidate.getAttribute("aria-label") ?? "",
        ].join(" "),
      );

      if (!text) {
        continue;
      }

      if (regexes.some((regex) => regex.test(text))) {
        candidate.click();
        return text;
      }
    }

    return "";
  }, { entries: serializedPatterns });
}

async function clickJoinButton() {
  const joinTexts = [/ask to join/i, /join now/i, /request to join/i];
  const clickedText = await clickVisibleButton(joinTexts);
  return Boolean(clickedText);
}

async function dismissMediaChoiceScreen() {
  const selectors = [
    'button:has-text("Continue without microphone and camera")',
    'button:has-text("Continue without microphone")',
    'button:has-text("Continue without camera")',
    '[data-mdc-dialog-action="cancel"]',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if ((await locator.count()) === 0) {
        continue;
      }
      await locator.click({ force: true, timeout: 2000 });
      await page.waitForTimeout(1000);
      return true;
    } catch {
      // Fall through to the next selector.
    }
  }

  return false;
}

async function hasCaptionsButton() {
  return page.evaluate(() => {
    return Array.from(
      document.querySelectorAll(".google-symbols, .google-material-icons, .material-icons-extended"),
    ).some((element) => element.textContent?.trim() === "closed_caption_off");
  });
}

async function waitForCaptionsButton(timeoutMs) {
  await page.waitForFunction(
    () => {
      return Array.from(
        document.querySelectorAll(".google-symbols, .google-material-icons, .material-icons-extended"),
      ).some((element) => element.textContent?.trim() === "closed_caption_off");
    },
    { timeout: timeoutMs },
  );
}

async function enableCaptions() {
  const clicked = await page.evaluate(() => {
    const icon = Array.from(
      document.querySelectorAll(".google-symbols, .google-material-icons, .material-icons-extended"),
    ).find((element) => element.textContent?.trim() === "closed_caption_off");
    const button = icon?.closest("button");
    if (button instanceof HTMLButtonElement) {
      button.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    await page.keyboard.press("c").catch(() => {});
  }
}

async function completePreJoinFlow(botDisplayName) {
  const startedAt = Date.now();
  let lastStatusKey = "";

  while (Date.now() - startedAt < 120000) {
    if (page.isClosed()) {
      const recovered = await activateMeetPageIfAvailable(
        "Google Meet switched tabs during pre-join. Continuing with the active Meet tab.",
      );
      if (!recovered) {
        throw new Error("The bot browser closed during Google Meet pre-join.");
      }
    }

    if (/accounts\.google\.com/i.test(page.url())) {
      throw new Error(
        "The bot runner profile is not signed into Google yet. Run `npm run poc:meet-login`, sign into the bot Google account in the opened browser, close it, then retry Start Bot.",
      );
    }

    await fillGuestNameIfNeeded(botDisplayName);

    const continuedWithoutMedia =
      (await dismissMediaChoiceScreen()) ||
      Boolean(
        await clickVisibleButton([
          /continue without microphone and camera/i,
          /continue without microphone/i,
          /continue without camera/i,
        ]),
      );
    if (continuedWithoutMedia) {
      emitStatus(
        "preparing",
        "Meet asked about microphone or camera access. Continuing without them for the bot.",
      );
      await page.waitForTimeout(1500);
      continue;
    }

    await ensureMediaOff().catch(() => {});

    if (await clickJoinButton()) {
      joinRequestSent = true;
      return "requested";
    }

    if (await hasCaptionsButton()) {
      meetingJoined = true;
      return "joined";
    }

    const screenState = await page.evaluate(() => {
      const text = document.body?.innerText?.replace(/\s+/g, " ").trim() ?? "";
      if (!text) {
        return null;
      }

      if (/someone in the meeting should let you in soon/i.test(text)) {
        return {
          stage: "waitingForAdmission",
          message: "Join request sent. Waiting for the host to admit the bot.",
          key: "waiting-for-admission",
        };
      }

      if (/do you want people to see and hear you in the meeting/i.test(text)) {
        return {
          stage: "preparing",
          message: "Meet is showing the camera and microphone chooser for the bot window.",
          key: "media-choice-screen",
        };
      }

      if (/you can't join this video call/i.test(text) || /this meeting is full/i.test(text)) {
        return {
          stage: "failed",
          message:
            "Google Meet blocked the bot before host admission. This meeting is not allowing this bot identity to request access. Sign the runner into an allowed Google account or relax the meeting guest-access policy.",
          key: "join-rejected",
        };
      }

      if (
        /choose an account/i.test(text) ||
        /use another account/i.test(text) ||
        /sign in to continue/i.test(text)
      ) {
        return {
          stage: "failed",
          message:
            "The bot runner profile is not signed into Google yet. Run `npm run poc:meet-login`, sign into the bot Google account, then retry Start Bot.",
          key: "signin-required",
        };
      }

      if (/your name/i.test(text)) {
        return {
          stage: "preparing",
          message: "Preparing the bot guest identity before joining the meeting.",
          key: "guest-name-screen",
        };
      }

      return null;
    });

    if (screenState?.stage === "failed") {
      throw new Error(screenState.message);
    }

    if (screenState && screenState.key !== lastStatusKey) {
      lastStatusKey = screenState.key;
      emitStatus(screenState.stage, screenState.message);
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(
    "Timed out waiting for the Google Meet join flow. If the bot is still on a permission or sign-in screen, check the diagnostics folder.",
  );
}

async function sendJoinMessageIfPossible(joinMessage) {
  if (!joinMessage?.trim()) {
    return;
  }

  try {
    const chatOpened = await page.evaluate(() => {
      const chatIcon = Array.from(
        document.querySelectorAll(".google-symbols, .google-material-icons, .material-icons-extended"),
      ).find((element) => element.textContent?.trim() === "chat");
      const button = chatIcon?.closest("button");
      if (button instanceof HTMLButtonElement) {
        button.click();
        return true;
      }

      return false;
    });

    if (!chatOpened) {
      return;
    }

    await page.waitForTimeout(1000);
    const textbox = page.locator('textarea, [role="textbox"]').first();
    if ((await textbox.count()) > 0) {
      await textbox.fill(joinMessage);
      await textbox.press("Enter");
      emitStatus("joined", "Join message sent to Meet chat.");
    }
  } catch (error) {
    emitStatus(
      "joined",
      `Could not send the join message automatically: ${error.message}`,
    );
  }
}

async function installTranscriptObserver(botDisplayName) {
  await page.exposeFunction("__meetingRecordingEmitEvent", (payload) => {
    if (payload?.type === "transcript" && payload.speaker && payload.text) {
      emit("transcript", payload);
      return;
    }

    if (payload?.type === "status") {
      emitStatus(payload.stage ?? "capturing", payload.message ?? "Transcript observer update");
    }
  });

  await page.evaluate((displayName) => {
    window.__meetingRecordingObserver?.disconnect?.();
    if (window.__meetingRecordingScanTimer) {
      window.clearInterval(window.__meetingRecordingScanTimer);
    }
    if (window.__meetingRecordingNoCaptionTimer) {
      window.clearTimeout(window.__meetingRecordingNoCaptionTimer);
    }

    let lastCommittedSignature = "";
    let sawCaption = false;

    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const blockList = [
      /^meeting details$/i,
      /^people$/i,
      /^chat$/i,
      /^activities$/i,
      /^host controls$/i,
      /^captions?$/i,
      /^turn on captions$/i,
      /^turn off captions$/i,
      /^you$/i,
    ];

    const isVisible = (element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };

    const isUsefulCaptionText = (text) => {
      if (!text || text.length < 2 || text.length > 700) {
        return false;
      }
      if (blockList.some((pattern) => pattern.test(text))) {
        return false;
      }
      return /[A-Za-z0-9]/.test(text);
    };

    const normalizeSpeaker = (speaker) => {
      const normalized = normalize(speaker);
      if (!normalized || normalized === "You") {
        return displayName;
      }
      return normalized;
    };

    const findSpeakerNear = (element) => {
      for (
        let current = element.parentElement;
        current && current !== document.body;
        current = current.parentElement
      ) {
        const speakerElement = current.querySelector(
          ".zs7s8d, [class*='zs7s8d'], [data-participant-id], [data-self-name]",
        );
        const speaker = normalize(speakerElement?.textContent ?? "");
        if (speaker && speaker !== normalize(element.textContent ?? "")) {
          return normalizeSpeaker(speaker);
        }

        const previous = current.previousElementSibling;
        const previousText = normalize(previous?.textContent ?? "");
        if (
          previousText &&
          previousText.length <= 80 &&
          !blockList.some((pattern) => pattern.test(previousText))
        ) {
          return normalizeSpeaker(previousText);
        }
      }

      return "";
    };

    const parseContainer = (container) => {
      const lines = (container.innerText || "")
        .split("\n")
        .map(normalize)
        .filter(Boolean);
      if (lines.length < 2 || lines.length > 8) {
        return null;
      }

      const speaker = normalizeSpeaker(lines[0]);
      const text = normalize(lines.slice(1).join(" "));
      if (!isUsefulCaptionText(text)) {
        return null;
      }

      return { speaker, text };
    };

    const collectCaptionCandidates = () => {
      const candidates = [];
      const legacyCaptionElements = Array.from(document.querySelectorAll(".iTTPOb"));
      for (const element of legacyCaptionElements) {
        if (!isVisible(element)) {
          continue;
        }

        const text = normalize(element.textContent ?? "");
        if (!isUsefulCaptionText(text)) {
          continue;
        }

        candidates.push({
          speaker: findSpeakerNear(element) || "Unknown speaker",
          text,
        });
      }

      const containerSelectors = [
        "div[jscontroller='TEjq6e']",
        "[aria-live='polite']",
        "[aria-live='assertive']",
        "[role='log']",
      ];
      const containers = Array.from(document.querySelectorAll(containerSelectors.join(",")));
      for (const container of containers) {
        if (!isVisible(container)) {
          continue;
        }

        const parsed = parseContainer(container);
        if (parsed) {
          candidates.push(parsed);
        }
      }

      return candidates;
    };

    const emitCandidate = ({ speaker, text }) => {
      const normalizedSpeaker = normalizeSpeaker(speaker);
      const normalizedText = normalize(text);
      if (!normalizedSpeaker || !isUsefulCaptionText(normalizedText)) {
        return;
      }

      const signature = `${normalizedSpeaker}::${normalizedText}`;
      if (signature === lastCommittedSignature) {
        return;
      }

      sawCaption = true;
      lastCommittedSignature = signature;
      window.__meetingRecordingEmitEvent({
        type: "transcript",
        speaker: normalizedSpeaker,
        text: normalizedText,
        timestamp: new Date().toISOString(),
      });
    };

    const scanForCaptions = () => {
      try {
        collectCaptionCandidates().forEach(emitCandidate);
      } catch (error) {
        window.__meetingRecordingEmitEvent({
          type: "status",
          stage: "capturing",
          message: `Transcript scan error: ${error.message}`,
        });
      }
    };

    const observer = new MutationObserver(scanForCaptions);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    window.__meetingRecordingFlush = scanForCaptions;
    window.__meetingRecordingObserver = observer;
    window.__meetingRecordingScanTimer = window.setInterval(scanForCaptions, 1000);
    window.__meetingRecordingNoCaptionTimer = window.setTimeout(() => {
      if (!sawCaption) {
        window.__meetingRecordingEmitEvent({
          type: "status",
          stage: "capturing",
          message: "Bot is in the meeting, but no Google Meet caption text has appeared yet.",
        });
      }
    }, 30000);

    scanForCaptions();
  }, botDisplayName);
}

async function flushTranscriptObserver() {
  if (!page || page.isClosed()) {
    return;
  }

  try {
    await page.evaluate(() => {
      window.__meetingRecordingFlush?.();
      window.__meetingRecordingObserver?.disconnect?.();
      if (window.__meetingRecordingScanTimer) {
        window.clearInterval(window.__meetingRecordingScanTimer);
      }
      if (window.__meetingRecordingNoCaptionTimer) {
        window.clearTimeout(window.__meetingRecordingNoCaptionTimer);
      }
    });
  } catch {
    // Ignore cleanup failures during shutdown.
  }
}

async function closeResources(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  await flushTranscriptObserver();

  if (context) {
    try {
      await context.close();
    } catch {
      // Ignore cleanup failures.
    }
  }

  if (userDataDir) {
    if (deleteUserDataDirOnExit) {
      try {
        await fs.rm(userDataDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures.
      }
    }
    userDataDir = undefined;
  }

  if (exitCode === 0) {
    emit("finished", { message: "Bot runtime finished." });
  }
  process.exit(exitCode);
}

async function main() {
  const { configPath } = parseArguments();
  const configuration = await readConfiguration(configPath);
  diagnosticsDirectory = configuration.diagnosticsDirectory;

  emitStatus(
    "preparing",
    configuration.headless === false
      ? "Launching a silent Google Meet bot participant..."
      : "Launching a headless Google Meet bot participant...",
  );
  emitStatus("preparing", `Using bot Chrome profile at ${resolveProfileDirectory(configuration)}.`);
  await launchBrowser(configuration);

  process.on("SIGTERM", async () => {
    emitStatus("stopping", "Received stop signal. Shutting down the bot...");
    await closeResources(0);
  });

  process.on("SIGINT", async () => {
    emitStatus("stopping", "Received interrupt signal. Shutting down the bot...");
    await closeResources(0);
  });

  emitStatus("launchingBrowser", "Navigating to Google Meet...");
  await page.goto(configuration.meetingURL, { waitUntil: "domcontentloaded" });

  const joinFlowResult = await completePreJoinFlow(configuration.botDisplayName);
  if (joinFlowResult === "requested") {
    emitStatus(
      "waitingForAdmission",
      "Join request sent. Admit the bot in Google Meet if the meeting requires approval.",
    );
  } else {
    emitStatus("joined", "The bot reached the meeting room directly.");
  }

  await waitForCaptionsButton(120000);
  meetingJoined = true;
  await enforcePassiveMeetingState();
  await enableCaptions();

  const resolvedMeetingTitle = await page.evaluate(() => {
    return document.querySelector(".u6vdEc")?.innerText?.trim() || document.title;
  });

  emit("joined", {
    meetingTitle: resolvedMeetingTitle,
    message: "Bot joined the meeting and enabled captions.",
  });

  await sendJoinMessageIfPossible(configuration.joinMessage);
  await installTranscriptObserver(configuration.botDisplayName);
  emitStatus("capturing", "Listening for speaker-tagged caption updates...");

  await new Promise(() => {});
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await captureDiagnostics(message);
  emit("error", { message });
  await closeResources(1);
});
