/**
 * Batching utilities for FlowFn
 */

export interface BatchOptions {
  /**
   * Maximum number of items per batch
   */
  maxSize: number;

  /**
   * Maximum time to wait before flushing batch (ms)
   */
  maxWait?: number;

  /**
   * Minimum size before processing (default: 1)
   */
  minSize?: number;
}

export interface BatchProcessor<T, R> {
  /**
   * Process a batch of items
   */
  (items: T[]): Promise<R[]>;
}

/**
 * Batch accumulator for collecting and processing items in batches
 */
export class BatchAccumulator<T, R = any> {
  private batch: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  private options: Required<BatchOptions>;
  private processor: BatchProcessor<T, R>;
  private pending: Array<{
    resolve: (value: R) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(processor: BatchProcessor<T, R>, options: BatchOptions) {
    this.processor = processor;
    this.options = {
      minSize: 1,
      maxWait: 1000,
      ...options,
    };
  }

  /**
   * Add an item to the batch
   */
  async add(item: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.batch.push(item);
      this.pending.push({ resolve, reject });

      // Flush if batch is full
      if (this.batch.length >= this.options.maxSize) {
        this.flush();
      } else if (!this.timer) {
        // Set timer for max wait
        this.timer = setTimeout(() => {
          this.flush();
        }, this.options.maxWait);
      }
    });
  }

  /**
   * Manually flush the current batch
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.batch.length < this.options.minSize) {
      return;
    }

    const currentBatch = this.batch;
    const currentPending = this.pending;

    this.batch = [];
    this.pending = [];

    try {
      const results = await this.processor(currentBatch);

      // Resolve all pending promises
      for (let i = 0; i < currentPending.length; i++) {
        currentPending[i].resolve(results[i]);
      }
    } catch (error) {
      // Reject all pending promises
      for (const pending of currentPending) {
        pending.reject(error as Error);
      }
    }
  }

  /**
   * Get current batch size
   */
  size(): number {
    return this.batch.length;
  }

  /**
   * Clear the batch without processing
   */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.batch = [];

    // Reject all pending
    for (const pending of this.pending) {
      pending.reject(new Error("Batch cleared"));
    }
    this.pending = [];
  }
}

/**
 * Create a batched version of a function
 */
export function batch<T, R>(
  fn: (items: T[]) => Promise<R[]>,
  options: BatchOptions,
): (item: T) => Promise<R> {
  const accumulator = new BatchAccumulator(fn, options);
  return (item: T) => accumulator.add(item);
}

/**
 * Batch array into chunks
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Process array in batches with delay between batches
 */
export async function processBatches<T, R>(
  items: T[],
  processor: (batch: T[]) => Promise<R[]>,
  options: { batchSize: number; delayMs?: number },
): Promise<R[]> {
  const batches = chunk(items, options.batchSize);
  const results: R[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batchResults = await processor(batches[i]);
    results.push(...batchResults);

    // Add delay between batches (except after last batch)
    if (i < batches.length - 1 && options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }

  return results;
}

/**
 * Batch write operations with auto-flush
 */
export class BatchWriter<T> {
  private accumulator: BatchAccumulator<T, void>;

  constructor(writer: (items: T[]) => Promise<void>, options: BatchOptions) {
    this.accumulator = new BatchAccumulator(async (items) => {
      await writer(items);
      return new Array(items.length).fill(undefined);
    }, options);
  }

  async write(item: T): Promise<void> {
    return this.accumulator.add(item);
  }

  async flush(): Promise<void> {
    return this.accumulator.flush();
  }

  size(): number {
    return this.accumulator.size();
  }

  clear(): void {
    this.accumulator.clear();
  }
}

/**
 * Group items by a key function and process in batches
 */
export async function batchByKey<T, R>(
  items: T[],
  keyFn: (item: T) => string,
  processor: (key: string, items: T[]) => Promise<R[]>,
  options?: { concurrency?: number },
): Promise<R[]> {
  const grouped = new Map<string, T[]>();

  // Group items by key
  for (const item of items) {
    const key = keyFn(item);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(item);
  }

  // Process each group
  const results: R[] = [];
  const entries = Array.from(grouped.entries());

  if (options?.concurrency) {
    // Process with concurrency limit
    for (let i = 0; i < entries.length; i += options.concurrency) {
      const batch = entries.slice(i, i + options.concurrency);
      const batchResults = await Promise.all(
        batch.map(([key, items]) => processor(key, items)),
      );
      results.push(...batchResults.flat());
    }
  } else {
    // Process sequentially
    for (const [key, keyItems] of entries) {
      const batchResults = await processor(key, keyItems);
      results.push(...batchResults);
    }
  }

  return results;
}
