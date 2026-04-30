import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MeetAdapter } from 'recfn-meet';
import {
  createBotWorker,
  createConsoleLogger,
  createMemoryStore,
  createRecFnServer,
  MemoryQueueAdapter,
  MemoryStorageAdapter,
} from './index.js';

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function requestHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(key, item);
    } else if (value !== undefined) {
      out.set(key, value);
    }
  }
  return out;
}

async function requestBody(req: import('node:http').IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

async function main(): Promise<void> {
  const host = env('RECFN_HOST', '0.0.0.0');
  const port = Number.parseInt(env('RECFN_PORT', '8787'), 10);
  const apiKey = env('RECFN_API_KEY', 'sk-local-dev');
  const namespace = env('RECFN_NAMESPACE', 'poc');
  const profileDir = env(
    'RECFN_MEET_PROFILE_DIR',
    join(homedir(), '.recfn', 'profiles', 'google-meet-bot'),
  );
  const chromeExecutablePath = process.env.RECFN_CHROME_EXECUTABLE_PATH;
  const headless = envBool('RECFN_BOT_HEADLESS', false);
  const useFakeMediaDevices = envBool('RECFN_USE_FAKE_MEDIA_DEVICES', false);

  await mkdir(profileDir, { recursive: true });

  const store = createMemoryStore();
  const storage = new MemoryStorageAdapter();
  const queue = new MemoryQueueAdapter();
  const logger = createConsoleLogger();

  const recfn = createRecFnServer({
    store,
    storage,
    queue,
    logger,
    environment: 'development',
    rateLimit: false,
    validateApiKey: (key) =>
      key === apiKey ? { namespace, apiKey: key } : null,
  });

  const worker = createBotWorker({
    store,
    storage,
    queue,
    logger,
    platformAdapterFactories: new Map([
      [
        'meet',
        () =>
          new MeetAdapter({
            userDataDir: profileDir,
            headless,
            executablePath: chromeExecutablePath,
            browserArgs: [
              '--disable-blink-features=AutomationControlled',
              '--disable-infobars',
              ...(useFakeMediaDevices ? ['--use-fake-device-for-media-stream'] : []),
              '--window-size=1280,800',
            ],
          }),
      ],
    ]),
  });

  let workerBusy = false;
  const workerTimer = setInterval(() => {
    if (workerBusy) return;
    workerBusy = true;
    void (async () => {
      try {
        while (await worker.processNext()) {
          // Drain currently queued jobs.
        }
      } catch (error) {
        logger.error('hosted_bot.worker_error', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        workerBusy = false;
      }
    })();
  }, 1_000);

  const httpServer = createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
      const url = new URL(req.url ?? '/', origin);

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const body = await requestBody(req);
      const request = new Request(url, {
        method: req.method,
        headers: requestHeaders(req.headers),
        body,
      });
      const response = await recfn.router.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
    } catch (error) {
      logger.error('hosted_bot.request_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
    }
  });

  httpServer.listen(port, host, () => {
    logger.info('hosted_bot.started', {
      host,
      port,
      namespace,
      profileDir,
      headless,
      chromeExecutablePath,
    });
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      clearInterval(workerTimer);
      worker.getAutoLeaveTimer().cancelAll();
      httpServer.close(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
