export interface BatcherOptions<T> {
  maxSize?: number;
  maxWait?: number;
  onFlush: (items: T[]) => void | Promise<void>;
}

export class Batcher<T> {
  private items: T[] = [];
  private maxSize: number;
  private maxWait: number;
  private onFlush: (items: T[]) => void | Promise<void>;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: BatcherOptions<T>) {
    this.maxSize = options.maxSize || 100;
    this.maxWait = options.maxWait || 5000;
    this.onFlush = options.onFlush;
  }

  add(item: T) {
    this.items.push(item);

    if (this.items.length >= this.maxSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxWait);
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.items.length === 0) return;

    const itemsToFlush = [...this.items];
    this.items = [];

    await this.onFlush(itemsToFlush);
  }
}
