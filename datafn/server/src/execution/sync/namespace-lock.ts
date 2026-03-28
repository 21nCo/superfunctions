class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
    }
  }
}

const adapterNamespaceMutexes = new WeakMap<object, Map<string, AsyncMutex>>();

function getMutex(adapter: object, namespace: string): AsyncMutex {
  let namespaceMutexes = adapterNamespaceMutexes.get(adapter);
  if (!namespaceMutexes) {
    namespaceMutexes = new Map<string, AsyncMutex>();
    adapterNamespaceMutexes.set(adapter, namespaceMutexes);
  }

  let mutex = namespaceMutexes.get(namespace);
  if (!mutex) {
    mutex = new AsyncMutex();
    namespaceMutexes.set(namespace, mutex);
  }

  return mutex;
}

export function withAdapterNamespaceLock<T>(
  adapter: object,
  namespace: string,
  task: () => Promise<T>,
): Promise<T> {
  return getMutex(adapter, namespace).runExclusive(task);
}
