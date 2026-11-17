import type { AddressInfo } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createOCRProcessor,
  createPdfPreviewProcessor,
  createThumbnailProcessor,
  type Processor,
} from '@filefn/processing';
import { createFileFn, createProcessingJobHandler } from '@filefn/server';
import type { Adapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/adapters/memory';
import { createR2StorageAdapter } from '@superfunctions/storage-r2';
import { ContainerConfigError, readContainerConfig, type ContainerConfig, type ContainerEnv } from './config.js';
import { createJobServer, type ContainerJobHandler } from './server.js';
import { createTesseractCliOCRProvider } from './tesseract-cli.js';

export { readContainerConfig, ContainerConfigError, CONTAINER_PROCESSORS } from './config.js';
export type { ContainerConfig, ContainerEnv, ContainerProcessorName } from './config.js';
export { BUSY_RETRY_AFTER_SECONDS, createJobServer } from './server.js';
export type { ContainerJobHandler, JobServer, JobServerOptions } from './server.js';
export { createTesseractCliOCRProvider } from './tesseract-cli.js';

/** A `FILEFN_DATABASE` module's default export. */
export type CreateDatabase = (env: ContainerEnv) => Adapter | Promise<Adapter>;

export interface RunningContainer {
  config: ContainerConfig;
  port: number;
  /**
   * Stops accepting requests, waits for every accepted job (including jobs
   * whose client disconnected), then closes the database.
   */
  close(): Promise<void>;
}

export interface StartContainerOptions {
  /** Replaces the FileFn processing job handler; for tests. */
  handler?: ContainerJobHandler;
}

/**
 * Loads the database adapter `FILEFN_DATABASE` names: `memory` (one process
 * only, for tests and local runs), or an ES module (a path, resolved from the
 * working directory, or a package name) whose default export is a
 * `CreateDatabase` function, for example one that returns a Drizzle adapter
 * over the host's Postgres schema.
 */
export async function loadDatabase(specifier: string, env: ContainerEnv): Promise<Adapter> {
  if (specifier === 'memory') return memoryAdapter();
  const target = specifier.startsWith('.') || isAbsolute(specifier)
    ? pathToFileURL(resolve(specifier)).href
    : specifier;
  const loaded = (await import(target)) as { default?: unknown };
  if (typeof loaded.default !== 'function') {
    throw new ContainerConfigError(`FILEFN_DATABASE module "${specifier}" must default-export a function that returns a database adapter`);
  }
  const database = await (loaded.default as CreateDatabase)(env);
  if (!database || typeof database !== 'object' || typeof database.findOne !== 'function') {
    throw new ContainerConfigError(`FILEFN_DATABASE module "${specifier}" did not return a database adapter`);
  }
  return database;
}

function buildProcessors(config: ContainerConfig): Processor[] {
  return config.processors.map((name) => {
    switch (name) {
      case 'thumbnail':
        return createThumbnailProcessor();
      case 'pdf-preview':
        return createPdfPreviewProcessor();
      case 'ocr':
        return createOCRProcessor({ language: config.ocrLanguage, provider: createTesseractCliOCRProvider() });
    }
  });
}

/** Starts the container's job server from its environment. */
export async function startContainer(env: ContainerEnv, options: StartContainerOptions = {}): Promise<RunningContainer> {
  const config = readContainerConfig(env);
  const database = await loadDatabase(config.database, env);
  try {
    const fileFn = createFileFn({
      database,
      storage: createR2StorageAdapter(config.storage),
      namespace: config.namespace,
      processing: { enabled: true, processors: buildProcessors(config) },
    });
    const handler = options.handler ?? createProcessingJobHandler(fileFn, { maxRetries: config.maxRetries });
    const server = createJobServer({
      handler,
      token: config.token,
      maxConcurrentJobs: config.maxConcurrentJobs,
      maxJobWaitMs: config.maxJobWaitMs,
      maxBodyBytes: config.maxBodyBytes,
      onError: (error) => console.error('[filefn-container] job failed', error),
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(config.port, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
    let closing: Promise<void> | undefined;
    return {
      config,
      port: (server.address() as AddressInfo).port,
      close() {
        closing ??= (async () => {
          const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          server.closeIdleConnections();
          await closed;
          // A job whose client disconnected no longer holds a connection open.
          await server.drainJobs();
          await database.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

async function main(): Promise<void> {
  const running = await startContainer(process.env);
  console.log(`[filefn-container] listening on port ${running.port} (processors: ${running.config.processors.join(', ')})`);
  const stop = (signal: string) => {
    console.log(`[filefn-container] ${signal}: finishing running jobs`);
    running.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[filefn-container] shutdown failed', error);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error: unknown) {
    console.error('[filefn-container] failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
