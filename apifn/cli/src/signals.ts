/**
 * Signal ownership for the standalone `apifn` binary. The library (runCli, runCheckCommand and the
 * publisher) never installs, inspects, removes or raises a process signal listener: an embedding
 * host keeps its own handling, and cancellation reaches `apifn check` only as an AbortSignal.
 */

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/** What the binary passes to the run: the abort signal and the publication report. */
export interface SignalOwner {
  signal: AbortSignal;
  onPublishing: (publishing: boolean) => void;
}

/**
 * Runs `run`, owning SIGINT, SIGTERM and SIGHUP from the moment it starts writing files (it says
 * so through `onPublishing`): before that no listener is installed, so a signal during loading or
 * generation keeps its default action even if a router never settles. While files are being
 * written, a signal aborts the run; once it has settled (the abort rolled back what it wrote), the
 * listeners are removed and the first signal is raised again, so it keeps its default action.
 * After the commit a signal keeps its default action at once.
 */
export async function withSignalAbort(run: (owner: SignalOwner) => Promise<number>): Promise<number> {
  const controller = new AbortController();
  let publishing = false;
  let received: NodeJS.Signals | undefined;
  const release = () => {
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  };
  function onSignal(signal: NodeJS.Signals): void {
    received ??= signal;
    if (publishing) {
      controller.abort(signal);
      return;
    }
    release();
    process.kill(process.pid, signal);
  }
  let installed = false;
  try {
    return await run({
      signal: controller.signal,
      onPublishing: (value) => {
        publishing = value;
        if (!value || installed) return;
        installed = true;
        for (const signal of SIGNALS) process.on(signal, onSignal);
      },
    });
  } finally {
    // A signal raised during the run's last synchronous steps reaches the listener first.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    release();
    if (controller.signal.aborted && received !== undefined) process.kill(process.pid, received);
  }
}
