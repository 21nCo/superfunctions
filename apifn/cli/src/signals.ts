/**
 * Signal ownership for the standalone `apifn` binary. The library (runCli, runCheckCommand and the
 * publisher) never installs, inspects, removes or raises a process signal listener: an embedding
 * host keeps its own handling, and cancellation reaches `apifn check` only as an AbortSignal.
 */

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Runs `run` with SIGINT, SIGTERM and SIGHUP turned into an abort of its signal. Once `run` has
 * settled (an abort rolls back what `apifn check` wrote), the listeners are removed and the first
 * signal received is raised again, so it keeps its default action.
 */
export async function withSignalAbort(run: (signal: AbortSignal) => Promise<number>): Promise<number> {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    received ??= signal;
    controller.abort(signal);
  };
  for (const signal of SIGNALS) process.on(signal, onSignal);
  try {
    return await run(controller.signal);
  } finally {
    // A signal raised during the run's last synchronous steps reaches the listener first.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
    if (received !== undefined) process.kill(process.pid, received);
  }
}
