import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = __dirname;
const workerScriptPath = path.join(runtimeRoot, "googleMeetBot.mjs");

const PORT = Number.parseInt(process.env.RECFN_BOT_RUNNER_PORT ?? "4040", 10);
const API_KEY = process.env.RECFN_BOT_RUNNER_API_KEY ?? "recfn-local-dev-key";
const DEFAULT_HEADLESS = !["0", "false", "no"].includes(
  String(process.env.RECFN_BOT_RUNNER_HEADLESS ?? "true").toLowerCase(),
);
const DEFAULT_PROFILE_NAME = sanitizeProfileName(
  process.env.RECFN_BOT_PROFILE_NAME ?? "default",
);
const DEFAULT_PROFILE_DIR = process.env.RECFN_BOT_PROFILE_DIR
  ? path.resolve(process.env.RECFN_BOT_PROFILE_DIR)
  : null;
const runsRoot = path.resolve(
  process.env.RECFN_BOT_RUNNER_OUTPUT_DIR ?? path.join(runtimeRoot, ".runs"),
);

const sessions = new Map();

function now() {
  return new Date().toISOString();
}

function sanitizeProfileName(value) {
  const trimmed = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return trimmed || "default";
}

function isTerminalStage(stage) {
  return stage === "finished" || stage === "failed";
}

function trimLog(log, limit = 200) {
  if (log.length <= limit) {
    return log;
  }
  return log.slice(log.length - limit);
}

function appendActivity(session, message) {
  const stamped = `[${new Date().toLocaleTimeString()}] ${message}`;
  session.activityLog = trimLog([...session.activityLog, stamped]);
  session.updatedAt = now();
}

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function errorEnvelope(code, message, details = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

function okEnvelope(data) {
  return {
    ok: true,
    data,
  };
}

function requireAuth(request, response) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token && token === API_KEY) {
    return true;
  }

  json(
    response,
    401,
    errorEnvelope("UNAUTHORIZED", "Missing or invalid Authorization header."),
  );
  return false;
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildSessionPayload(session) {
  return {
    botId: session.botId,
    stage: session.stage,
    statusMessage: session.statusMessage,
    meetingTitle: session.meetingTitle,
    transcript: session.transcript,
    activityLog: session.activityLog,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    diagnosticsDirectory: session.diagnosticsDirectory,
    isRunning: session.isRunning,
    exitCode: session.exitCode,
  };
}

function updateFromRuntimeEvent(session, event) {
  if (!event || typeof event !== "object") {
    return;
  }

  if (event.type === "status") {
    if (typeof event.stage === "string" && event.stage.length > 0) {
      session.stage = event.stage;
    }
    if (typeof event.message === "string" && event.message.length > 0) {
      session.statusMessage = event.message;
      appendActivity(session, event.message);
    }
    return;
  }

  if (event.type === "joined") {
    session.stage = "joined";
    session.meetingTitle =
      typeof event.meetingTitle === "string" && event.meetingTitle.length > 0
        ? event.meetingTitle
        : session.meetingTitle;
    session.statusMessage =
      typeof event.message === "string" && event.message.length > 0
        ? event.message
        : "Bot joined the meeting.";
    appendActivity(session, session.statusMessage);
    return;
  }

  if (event.type === "transcript") {
    if (typeof event.speaker !== "string" || typeof event.text !== "string") {
      return;
    }

    const segment = {
      speaker: event.speaker,
      text: event.text,
      timestamp:
        typeof event.timestamp === "string" && event.timestamp.length > 0
          ? event.timestamp
          : now(),
    };
    const last = session.transcript.at(-1);
    if (
      last &&
      last.speaker === segment.speaker &&
      last.text === segment.text
    ) {
      return;
    }

    session.stage = "capturing";
    session.transcript = [...session.transcript, segment];
    session.statusMessage = `Capturing transcript from ${new Set(
      session.transcript.map((entry) => entry.speaker),
    ).size} participant(s).`;
    session.updatedAt = now();
    return;
  }

  if (event.type === "error") {
    session.stage = "failed";
    session.statusMessage =
      typeof event.message === "string" && event.message.length > 0
        ? event.message
        : "Bot failed.";
    session.isRunning = false;
    appendActivity(session, `error: ${session.statusMessage}`);
    return;
  }

  if (event.type === "finished") {
    session.stage = "finished";
    session.statusMessage =
      typeof event.message === "string" && event.message.length > 0
        ? event.message
        : "Bot finished.";
    session.isRunning = false;
    appendActivity(session, session.statusMessage);
  }
}

function consumeJsonLines(bufferState, text, onLine) {
  bufferState.value += text;
  const lines = bufferState.value.split("\n");
  bufferState.value = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    onLine(trimmed);
  }
}

async function createSession(configuration) {
  const botId = `bot_${randomUUID()}`;
  const diagnosticsDirectory = path.join(runsRoot, botId);
  await fs.mkdir(diagnosticsDirectory, { recursive: true });

  const configPath = path.join(diagnosticsDirectory, "config.json");
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        meetingURL: configuration.meetingUrl,
        botDisplayName: configuration.botDisplayName,
        joinMessage: configuration.joinMessage ?? "",
        diagnosticsDirectory,
        headless: configuration.headless ?? DEFAULT_HEADLESS,
        profileName: configuration.profileName ?? DEFAULT_PROFILE_NAME,
        profileDirectory: configuration.profileDirectory ?? DEFAULT_PROFILE_DIR,
      },
      null,
      2,
    ),
  );

  const child = spawn(process.execPath, [workerScriptPath, "--config", configPath], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const session = {
    botId,
    createdAt: now(),
    updatedAt: now(),
    stage: "preparing",
    statusMessage: "Launching remote Google Meet bot...",
    meetingTitle: "",
    transcript: [],
    activityLog: [],
    diagnosticsDirectory,
    configPath,
    process: child,
    isRunning: true,
    exitCode: null,
  };
  appendActivity(session, session.statusMessage);
  sessions.set(botId, session);

  const stdoutBuffer = { value: "" };
  const stderrBuffer = { value: "" };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    consumeJsonLines(stdoutBuffer, chunk, (line) => {
      try {
        const event = JSON.parse(line);
        updateFromRuntimeEvent(session, event);
      } catch {
        appendActivity(session, `runtime: ${line}`);
      }
    });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    consumeJsonLines(stderrBuffer, chunk, (line) => {
      appendActivity(session, `runtime: ${line}`);
    });
  });

  child.on("exit", (code) => {
    session.exitCode = code ?? 0;
    session.isRunning = false;
    if (!isTerminalStage(session.stage)) {
      if ((code ?? 0) === 0) {
        session.stage = "finished";
        if (!session.statusMessage) {
          session.statusMessage = "Bot finished.";
        }
      } else {
        session.stage = "failed";
        session.statusMessage = `Remote bot exited with status ${code ?? 1}.`;
      }
      appendActivity(session, session.statusMessage);
    }
  });

  child.on("error", (error) => {
    session.isRunning = false;
    session.stage = "failed";
    session.statusMessage = error.message;
    appendActivity(session, `error: ${error.message}`);
  });

  return session;
}

async function stopSession(session) {
  if (!session?.process || !session.isRunning) {
    return;
  }

  session.stage = "stopping";
  session.statusMessage = "Stopping remote bot...";
  appendActivity(session, session.statusMessage);

  session.process.kill("SIGTERM");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (request.method === "GET" && url.pathname === "/health") {
    json(
      response,
      200,
      okEnvelope({
        ok: true,
        service: "recfn-google-meet-bot-runner",
        headless: DEFAULT_HEADLESS,
        profileName: DEFAULT_PROFILE_NAME,
        profileDirectory: DEFAULT_PROFILE_DIR,
      }),
    );
    return;
  }

  if (!requireAuth(request, response)) {
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/v1/poc/bots") {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      json(
        response,
        400,
        errorEnvelope("BAD_REQUEST", "Invalid JSON request body.", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }

    if (typeof body.meetingUrl !== "string" || !body.meetingUrl.includes("meet.google.com")) {
      json(
        response,
        400,
        errorEnvelope("BAD_REQUEST", "meetingUrl must be a Google Meet URL."),
      );
      return;
    }

    const session = await createSession({
      meetingUrl: body.meetingUrl,
      botDisplayName:
        typeof body.botDisplayName === "string" && body.botDisplayName.trim().length > 0
          ? body.botDisplayName.trim()
          : "21n Notetaker",
      joinMessage:
        typeof body.joinMessage === "string" ? body.joinMessage : "",
      headless:
        typeof body.headless === "boolean" ? body.headless : DEFAULT_HEADLESS,
      profileName:
        typeof body.profileName === "string" && body.profileName.trim().length > 0
          ? sanitizeProfileName(body.profileName)
          : DEFAULT_PROFILE_NAME,
      profileDirectory:
        typeof body.profileDirectory === "string" && body.profileDirectory.trim().length > 0
          ? path.resolve(body.profileDirectory)
          : DEFAULT_PROFILE_DIR,
    });

    json(response, 201, okEnvelope(buildSessionPayload(session)));
    return;
  }

  const sessionMatch = url.pathname.match(/^\/api\/v1\/poc\/bots\/([^/]+)$/);
  if (request.method === "GET" && sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    if (!session) {
      json(response, 404, errorEnvelope("BOT_NOT_FOUND", "Bot session not found."));
      return;
    }

    json(response, 200, okEnvelope(buildSessionPayload(session)));
    return;
  }

  const stopMatch = url.pathname.match(/^\/api\/v1\/poc\/bots\/([^/]+)\/stop$/);
  if (request.method === "POST" && stopMatch) {
    const session = sessions.get(stopMatch[1]);
    if (!session) {
      json(response, 404, errorEnvelope("BOT_NOT_FOUND", "Bot session not found."));
      return;
    }

    await stopSession(session);
    json(response, 202, okEnvelope(buildSessionPayload(session)));
    return;
  }

  json(response, 404, errorEnvelope("NOT_FOUND", "Route not found."));
});

server.listen(PORT, async () => {
  await fs.mkdir(runsRoot, { recursive: true });
  console.log(
    JSON.stringify({
      level: "info",
      event: "recfn.poc_google_meet_runner.started",
      port: PORT,
      headless: DEFAULT_HEADLESS,
      profileName: DEFAULT_PROFILE_NAME,
      profileDirectory: DEFAULT_PROFILE_DIR,
      runsRoot,
      timestamp: now(),
    }),
  );
});
