import type { QueueClient } from '../queue/flowfn-client.js';
import { DEFAULT_QUEUE_NAME } from '../queue/flowfn-client.js';
import type { DispatchStore } from './types.js';

export const PUBLICATION_LEASE_MS = 5_000;
export const DELIVERY_RETRY_MS = 5_000;
export const UNCLAIMED_REDELIVERY_MS = 30_000;

export async function publishRun(store: DispatchStore, queue: QueueClient, runId: string, now = Date.now()): Promise<void> {
  const deliveries = await store.leaseDispatches(runId, now, PUBLICATION_LEASE_MS);
  for (const delivery of deliveries) {
    let delay = UNCLAIMED_REDELIVERY_MS;
    try { await queue.enqueue(DEFAULT_QUEUE_NAME, delivery.payload); }
    catch { delay = DELIVERY_RETRY_MS; console.error('CiFn queue publication failed; durable retry pending'); }
    // A failed acknowledgement keeps the publication lease until expiry. A
    // duplicate transport delivery is safe because assignment uses durable CAS.
    await store.finishPublication(runId, delivery.dispatchId, delivery.publicationToken, Date.now() + delay);
  }
}
/** One bounded page per tick; the cursor advances so older runs cannot starve. */
export class DispatchPublisher {
  private cursor?: string;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private store: DispatchStore, private queue: QueueClient) {}
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      const page = await this.store.listDispatchRuns(this.cursor);
      for (const runId of page.runIds) await publishRun(this.store, this.queue, runId);
      this.cursor = page.nextCursor;
    })().finally(() => { this.active = undefined; });
    return this.active;
  }
  start(): void {
    if (this.timer) return;
    const tick = () => { void this.tick().catch(() => console.error('CiFn dispatch publication failed; retry pending')); };
    this.timer = setInterval(tick, 1_000); this.timer.unref(); tick();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    await this.active;
  }
}
