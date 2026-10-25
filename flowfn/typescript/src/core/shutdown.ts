export interface ShutdownOptions { timeout?: number }
export const DEFAULT_SHUTDOWN_TIMEOUT = 25_000;
export class ShutdownTimeoutError extends Error {
  constructor(public readonly component: string, public readonly timeout: number) {
    super(`${component} shutdown timed out after ${timeout}ms`);
    this.name = 'ShutdownTimeoutError';
  }
}
export function shutdownTimeout(options: ShutdownOptions = {}): number {
  const timeout = options.timeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483647) throw new Error('Invalid shutdown timeout');
  return timeout;
}
export function boundedShutdown(work: Promise<unknown>, timeout: number, component: string, abandon: () => void = () => {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { abandon(); } catch { /* Preserve the timeout outcome. */ }
      reject(new ShutdownTimeoutError(component, timeout));
    }, timeout);
    work.then(
      () => { clearTimeout(timer); resolve(); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
