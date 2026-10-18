import { boundedShutdown, shutdownTimeout, type ShutdownOptions } from '../core/shutdown.js';
import { OperationObserver } from '../instrumentation.js';
import { randomUUID } from "node:crypto";
import type {
  Stream,
  Message,
  PublishOptions,
  SubscribeOptions,
  MessageHandler,
  Subscription,
  ConsumerOptions,
  Consumer,
  StreamInfo,
  TrimStrategy,
  StreamOptions,
} from "./types.js";
import type { FlowAdapter } from "../adapters/base.js";
export class StreamImpl<T = any> implements Stream<T> {
  private subscriptions = new Set<Subscription>();
  private consumers = new Set<Consumer<T>>();
  private closed = false;
  private closing?: Promise<void>;
  private count = 0;
  constructor(
    public name: string,
    private adapter: FlowAdapter,
    private options: StreamOptions = {},
    private record?: (metric: string, value: number) => void,
    private observer = new OperationObserver(),
  ) {
    for (const value of [options.maxLength, options.retention])
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new Error("Stream retention must be nonnegative");
  }
  private open() {
    if (this.closed) throw new Error("Stream is closed");
  }
  async publish(data: T, options: PublishOptions = {}): Promise<string> {
    this.open();
    const message: Message<T> = {
      id: randomUUID(),
      stream: this.name,
      data: structuredClone(data),
      headers: structuredClone(options.headers),
      timestamp: Date.now(),
      partition: options.partition,
      key: options.key,
      ack: async () => {},
      nack: async () => {},
    };
    const id = await this.adapter.publish(this.name, message);
    this.count++;
    this.record?.("stream.throughput", 1);
    if (
      this.options.maxLength !== undefined ||
      this.options.retention !== undefined
    )
      await this.trim({
        maxLength: this.options.maxLength,
        maxAgeSeconds:
          this.options.retention === undefined
            ? undefined
            : this.options.retention / 1000,
      });
    return id;
  }
  async publishBatch(
    messages: Array<{ data: T; options?: PublishOptions }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const message of messages)
      ids.push(await this.publish(message.data, message.options));
    return ids;
  }
  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions,
  ): Promise<Subscription> {
    this.open();
    const inner = await this.adapter.subscribe(
      this.name,
      async (message) => {
        this.open();
        this.record?.(
          "stream.latency",
          Math.max(0, Date.now() - message.timestamp),
        );
        await this.observer.run('flowfn.stream.process', { 'flowfn.stream': this.name, 'flowfn.message.id': message.id }, () => handler({ ...message, stream: this.name }));
      },
      options,
    );
    if (this.closed) { await inner.unsubscribe(); throw new Error("Stream is closed"); }
    const subscription: Subscription = {
      unsubscribe: async () => {
        await inner.unsubscribe();
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }
  createConsumer(id: string, options: ConsumerOptions): Consumer<T> {
    this.open();
    let subscription: Subscription | undefined,
      closed = false,
      paused = false;
    let closingConsumer: Promise<void> | undefined;
    const consumer: Consumer<T> = {
      subscribe: async (handler) => {
        this.open();
        if (closed || subscription)
          throw new Error("Consumer is closed or already subscribed");
        subscription = await this.adapter.consume(
          this.name,
          options.groupId,
          id,
          async (message) => {
            this.open();
            if (closed) throw new Error("Consumer is closed");
            this.record?.(
              "stream.latency",
              Math.max(0, Date.now() - message.timestamp),
            );
            await this.observer.run('flowfn.stream.process', { 'flowfn.stream': this.name, 'flowfn.message.id': message.id }, () => handler({ ...message, stream: this.name }));
          },
          options,
        );
        if (this.closed || closed) { await subscription.unsubscribe(); throw new Error("Consumer is closed"); }
        if (paused) {
          if (!subscription.pause)
            throw new Error("Adapter does not support consumer pause");
          await subscription.pause();
        }
      },
      pause: async () => {
        if (closed) throw new Error("Consumer is closed");
        paused = true;
        if (subscription) {
          if (!subscription.pause)
            throw new Error("Adapter does not support consumer pause");
          await subscription.pause();
        }
      },
      resume: async () => {
        if (closed) throw new Error("Consumer is closed");
        paused = false;
        if (subscription) {
          if (!subscription.resume)
            throw new Error("Adapter does not support consumer resume");
          await subscription.resume();
        }
      },
      close: (shutdown: ShutdownOptions = {}) => {
        const timeout = shutdownTimeout(shutdown);
        if (closingConsumer) return closingConsumer;
        closed = true;
        return closingConsumer = boundedShutdown(subscription?.unsubscribe() ?? Promise.resolve(), timeout, `Consumer ${id}`).finally(() => this.consumers.delete(consumer));
      },
    };
    this.consumers.add(consumer);
    return consumer;
  }
  async getInfo(): Promise<StreamInfo> {
    const info = await this.adapter.getStreamInfo(this.name);
    this.count = info.length;
    return { ...info, name: this.name };
  }
  async trim(strategy: TrimStrategy): Promise<number> {
    if (!this.adapter.trimStream)
      throw new Error("Adapter does not support retained stream trimming");
    const removed = await this.adapter.trimStream(this.name, strategy);
    this.count = Math.max(0, this.count - removed);
    return removed;
  }
  async getMessages(
    start: string,
    end: string,
    count?: number,
  ): Promise<Message<T>[]> {
    if (!this.adapter.getMessages)
      throw new Error("Adapter does not support retained stream reads");
    return (await this.adapter.getMessages(this.name, start, end, count)).map(
      (message) => ({ ...message, stream: this.name }),
    );
  }
  async replay(timestamp: number, handler: MessageHandler<T>): Promise<number> {
    if (!Number.isFinite(timestamp))
      throw new Error("Invalid replay timestamp");
    const messages = (await this.getMessages("-", "+")).filter(
      (message) => message.timestamp >= timestamp,
    );
    for (const message of messages) await handler(message);
    return messages.length;
  }
  getMessageCount() {
    return this.count;
  }
  close(options: ShutdownOptions = {}): Promise<void> {
    const timeout = shutdownTimeout(options);
    if (this.closing) return this.closing;
    this.closed = true;
    return this.closing = boundedShutdown(Promise.all([
      ...[...this.subscriptions].map(subscription => subscription.unsubscribe()),
      ...[...this.consumers].map(consumer => consumer.close({ timeout })),
    ]), timeout, `Stream ${this.name}`);
  }
}
