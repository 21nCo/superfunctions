import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** The part of `@filefn/server`'s `ProcessingJobHandler` the container calls. */
export interface ContainerJobHandler {
  handle(body: unknown, delivery?: { attempts?: number }): Promise<{ status: string }>;
}

export interface JobServerOptions {
  handler: ContainerJobHandler;
  /** When set, `POST /jobs` requires `Authorization: Bearer <token>`. */
  token?: string;
  /** Jobs run at once; a request past it gets 503 so the queue redelivers it. */
  maxConcurrentJobs: number;
  /** Largest accepted `POST /jobs` body in bytes. */
  maxBodyBytes: number;
  /** Reports a job that threw; `handle` is not expected to throw. */
  onError?: (error: unknown) => void;
}

/** Largest attempt number accepted from the caller. */
const MAX_ATTEMPTS = 1_000_000;

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: RequestError, headers?: Record<string, string>): void {
  send(res, error.status, { error: { code: error.code, message: error.message } }, headers);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
  return match !== null && timingSafeEqual(digest(match[1]), expected);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestError(413, 'FILEFN_CONTAINER_BODY_TOO_LARGE', `body exceeds ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      throw new RequestError(413, 'FILEFN_CONTAINER_BODY_TOO_LARGE', `body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses `{ "job": <queued message body>, "attempts"?: <1-based delivery attempt> }`. */
function parseJobRequest(raw: Buffer): { job: unknown; attempts: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new RequestError(400, 'FILEFN_CONTAINER_REQUEST_INVALID', 'body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('job' in parsed)) {
    throw new RequestError(400, 'FILEFN_CONTAINER_REQUEST_INVALID', 'body must be an object with a job');
  }
  const { job, attempts = 1 } = parsed as { job: unknown; attempts?: unknown };
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ATTEMPTS) {
    throw new RequestError(400, 'FILEFN_CONTAINER_REQUEST_INVALID', `attempts must be an integer from 1 to ${MAX_ATTEMPTS}`);
  }
  return { job, attempts };
}

/**
 * Creates the container's HTTP server. It serves only `GET /health` and
 * `POST /jobs`; `POST /jobs` runs one queued `filefn.processing` job through
 * the FileFn processing job handler and answers 200 with the handler's
 * `{ outcome }`. An outcome with status `retry` asks the caller to redeliver
 * the message; every other outcome means acknowledge it.
 */
export function createJobServer(options: JobServerOptions): Server {
  const { handler, maxConcurrentJobs, maxBodyBytes, onError } = options;
  const expectedToken = options.token ? digest(options.token) : undefined;
  let running = 0;

  async function runJob(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (expectedToken && !isAuthorized(req, expectedToken)) {
      throw new RequestError(401, 'FILEFN_CONTAINER_UNAUTHORIZED', 'a valid bearer token is required');
    }
    const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new RequestError(415, 'FILEFN_CONTAINER_UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json');
    }
    const { job, attempts } = parseJobRequest(await readBody(req, maxBodyBytes));
    if (running >= maxConcurrentJobs) {
      sendError(res, new RequestError(503, 'FILEFN_CONTAINER_BUSY', 'too many jobs are running'), { 'retry-after': '1' });
      return;
    }
    running += 1;
    try {
      const outcome = await handler.handle(job, { attempts });
      send(res, 200, { outcome });
    } finally {
      running -= 1;
    }
  }

  return createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const route = path === '/health' ? 'health' : path === '/jobs' ? 'jobs' : null;
    if (route === null) {
      sendError(res, new RequestError(404, 'FILEFN_CONTAINER_NOT_FOUND', 'not found'));
      return;
    }
    if (route === 'health') {
      if (req.method === 'GET' || req.method === 'HEAD') send(res, 200, { status: 'ok' });
      else sendError(res, new RequestError(405, 'FILEFN_CONTAINER_METHOD_NOT_ALLOWED', 'use GET'), { allow: 'GET, HEAD' });
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, new RequestError(405, 'FILEFN_CONTAINER_METHOD_NOT_ALLOWED', 'use POST'), { allow: 'POST' });
      return;
    }
    runJob(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof RequestError) {
        // Stop reading an oversized or rejected body; the response ends the exchange.
        sendError(res, error, { connection: 'close' });
        return;
      }
      onError?.(error);
      sendError(res, new RequestError(500, 'FILEFN_CONTAINER_JOB_ERROR', 'the job could not be run'));
    });
  });
}
