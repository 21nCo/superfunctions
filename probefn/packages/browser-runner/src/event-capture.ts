import type { ConsoleMessage, Page, Request, Response } from 'playwright';

import { ArtifactStore } from '@probefn/storage';

export interface BrowserConsoleEvent {
  ts: string;
  source: 'browser';
  type: 'console';
  level: string;
  text: string;
  pageUrl: string;
  location?: {
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
}

export interface BrowserPageErrorEvent {
  ts: string;
  source: 'browser';
  type: 'page-error';
  message: string;
  pageUrl: string;
  stack?: string;
}

export interface BrowserRequestFailedEvent {
  ts: string;
  source: 'browser';
  type: 'request-failed';
  url: string;
  method: string;
  resourceType: string;
  pageUrl: string;
  failureText?: string;
}

export interface BrowserResponseFailureEvent {
  ts: string;
  source: 'browser';
  type: 'response-failure';
  url: string;
  method: string;
  status: number;
  statusText: string;
  resourceType: string;
  pageUrl: string;
}

export type BrowserRuntimeEvent =
  | BrowserConsoleEvent
  | BrowserPageErrorEvent
  | BrowserRequestFailedEvent
  | BrowserResponseFailureEvent;

export interface BrowserEventCapturePaths {
  consoleSinkPath: string;
  pageErrorSinkPath: string;
  networkSinkPath: string;
}

export interface BrowserEventCapture {
  sinkPaths: BrowserEventCapturePaths;
  flush(): Promise<void>;
  dispose(): void;
}

export interface AttachEventCaptureOptions {
  page: Page;
  artifactStore: ArtifactStore;
  runId: string;
  now?: () => string;
}

export function attachBrowserEventCapture(
  options: AttachEventCaptureOptions,
): BrowserEventCapture {
  const now = options.now ?? (() => new Date().toISOString());
  const consoleSink = options.artifactStore.createEventSink(options.runId, 'console', 'events');
  const pageErrorSink = options.artifactStore.createEventSink(options.runId, 'page-errors', 'events');
  const networkSink = options.artifactStore.createEventSink(options.runId, 'network', 'events');
  type Write = { completion: Promise<void>; failed: boolean; error?: unknown };
  const pendingWrites = new Set<Write>();
  const failedWrites = new Set<Write>();
  const trackWrite = (operation: () => Promise<unknown>): void => {
    let finish!: () => void;
    const record: Write = { failed: false, completion: new Promise<void>(resolve => { finish = resolve; }) };
    pendingWrites.add(record);
    const settle = (failed: boolean, error?: unknown) => {
      record.failed = failed; record.error = error;
      if (failed) failedWrites.add(record);
      pendingWrites.delete(record);
      finish();
    };
    try { Promise.resolve(operation()).then(() => settle(false), error => settle(true, error)); }
    catch (error) { settle(true, error); }
  };

  const consoleHandler = (message: ConsoleMessage): void => {
    const event = toConsoleEvent(now(), options.page, message);
    if (shouldPersistConsoleEvent(event)) {
      trackWrite(() => consoleSink.append(event));
    }
  };

  const pageErrorHandler = (error: Error): void => {
    trackWrite(() => pageErrorSink.append(toPageErrorEvent(now(), options.page, error)));
  };

  const requestFailedHandler = (request: Request): void => {
    trackWrite(() => networkSink.append(toRequestFailedEvent(now(), options.page, request)));
  };

  const responseHandler = (response: Response): void => {
    if (response.status() >= 400) {
      trackWrite(() => networkSink.append(toResponseFailureEvent(now(), options.page, response)));
    }
  };

  options.page.on('console', consoleHandler);
  options.page.on('pageerror', pageErrorHandler);
  options.page.on('requestfailed', requestFailedHandler);
  options.page.on('response', responseHandler);

  return {
    sinkPaths: {
      consoleSinkPath: consoleSink.getCurrentRelativePath(),
      pageErrorSinkPath: pageErrorSink.getCurrentRelativePath(),
      networkSinkPath: networkSink.getCurrentRelativePath(),
    },
    async flush(): Promise<void> {
      const records = new Set([...failedWrites, ...pendingWrites]);
      await Promise.all([...records].map(record => record.completion));
      const failures = [...records].filter(record => record.failed);
      for (const record of failures) failedWrites.delete(record);
      if (failures.length) throw new AggregateError(failures.map(record => record.error), 'Browser event persistence failed');
    },
    dispose(): void {
      options.page.off('console', consoleHandler);
      options.page.off('pageerror', pageErrorHandler);
      options.page.off('requestfailed', requestFailedHandler);
      options.page.off('response', responseHandler);
    },
  };
}

function toConsoleEvent(
  ts: string,
  page: Page,
  message: ConsoleMessage,
): BrowserConsoleEvent {
  const location = message.location();
  return {
    ts,
    source: 'browser',
    type: 'console',
    level: message.type(),
    text: message.text(),
    pageUrl: page.url(),
    ...(location.url
      ? {
          location: {
            url: location.url,
            lineNumber: location.lineNumber,
            columnNumber: location.columnNumber,
          },
        }
      : {}),
  };
}

function shouldPersistConsoleEvent(event: BrowserConsoleEvent): boolean {
  return !/^Failed to load resource:/i.test(event.text);
}

function toPageErrorEvent(
  ts: string,
  page: Page,
  error: Error,
): BrowserPageErrorEvent {
  return {
    ts,
    source: 'browser',
    type: 'page-error',
    message: error.message,
    pageUrl: page.url(),
    ...(error.stack ? { stack: error.stack } : {}),
  };
}

function toRequestFailedEvent(
  ts: string,
  page: Page,
  request: Request,
): BrowserRequestFailedEvent {
  const failure = request.failure();
  return {
    ts,
    source: 'browser',
    type: 'request-failed',
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    pageUrl: page.url(),
    ...(failure?.errorText ? { failureText: failure.errorText } : {}),
  };
}

function toResponseFailureEvent(
  ts: string,
  page: Page,
  response: Response,
): BrowserResponseFailureEvent {
  return {
    ts,
    source: 'browser',
    type: 'response-failure',
    url: response.url(),
    method: response.request().method(),
    status: response.status(),
    statusText: response.statusText(),
    resourceType: response.request().resourceType(),
    pageUrl: page.url(),
  };
}
