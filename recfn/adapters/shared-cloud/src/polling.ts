export interface PollUntilOptions<T> {
  intervalMs: number;
  maxAttempts: number;
  isDone: (result: T) => boolean;
  onExhausted: () => Error;
}

export async function pollUntil<T>(
  runAttempt: () => Promise<T>,
  options: PollUntilOptions<T>,
): Promise<T> {
  let lastResult: T | undefined;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    lastResult = await runAttempt();
    if (options.isDone(lastResult)) {
      return lastResult;
    }
    if (attempt < options.maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }

  if (lastResult !== undefined && options.isDone(lastResult)) {
    return lastResult;
  }

  throw options.onExhausted();
}
