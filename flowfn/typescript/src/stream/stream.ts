import {
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
import { FlowAdapter } from "../adapters/base.js";
import { v4 as uuidv4 } from "uuid";

export class StreamImpl<T = any> implements Stream<T> {
  name: string;
  private adapter: FlowAdapter;
  private options: StreamOptions;
  private messages: Map<string, Message<T>> = new Map();

  constructor(name: string, adapter: FlowAdapter, options: StreamOptions = {}) {
    this.name = name;
    this.adapter = adapter;
    this.options = options;
  }

  async publish(data: T, options?: PublishOptions): Promise<string> {
    const message: Message<T> = {
      id: uuidv4(),
      stream: this.name,
      data,
      headers: options?.headers,
      timestamp: Date.now(),
      partition: options?.partition,
      key: options?.key,
      ack: async () => {},
      nack: async () => {},
    };

    // Store message locally for retrieval
    this.messages.set(message.id, message);

    // Auto-trim if maxLength is set
    if (this.options.maxLength && this.messages.size > this.options.maxLength) {
      await this.trim({ maxLength: this.options.maxLength });
    }

    return this.adapter.publish(this.name, message);
  }

  async publishBatch(
    messages: Array<{ data: T; options?: PublishOptions }>
  ): Promise<string[]> {
    return Promise.all(messages.map((m) => this.publish(m.data, m.options)));
  }

  async subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions
  ): Promise<Subscription> {
    return this.adapter.subscribe(this.name, handler as any);
  }

  createConsumer(consumerId: string, options: ConsumerOptions): Consumer<T> {
    let subscription: Subscription | null = null;
    let paused = false;

    return {
      subscribe: async (handler: MessageHandler<T>) => {
        // If fromBeginning, replay existing messages first
        if (options.fromBeginning && this.messages.size > 0) {
          const sortedMessages = Array.from(this.messages.values()).sort(
            (a, b) => a.timestamp - b.timestamp
          );

          for (const msg of sortedMessages) {
            if (!paused) {
              await handler(msg).catch(console.error);
            }
          }
        }

        subscription = await this.adapter.consume(
          this.name,
          options.groupId,
          consumerId,
          handler as any
        );
      },
      pause: async () => {
        paused = true;
      },
      resume: async () => {
        paused = false;
      },
      close: async () => {
        if (subscription) await subscription.unsubscribe();
      },
    };
  }

  async getInfo(): Promise<StreamInfo> {
    const info = await this.adapter.getStreamInfo(this.name);
    return {
      ...info,
      length: this.messages.size,
    };
  }

  async trim(strategy: TrimStrategy): Promise<number> {
    const now = Date.now();
    const messagesToDelete: string[] = [];

    if (strategy.maxLength) {
      // Sort by timestamp and keep only the newest maxLength messages
      const sortedMessages = Array.from(this.messages.entries()).sort(
        (a, b) => b[1].timestamp - a[1].timestamp
      );

      if (sortedMessages.length > strategy.maxLength) {
        const toRemove = sortedMessages.slice(strategy.maxLength);
        messagesToDelete.push(...toRemove.map(([id]) => id));
      }
    }

    if (strategy.maxAgeSeconds) {
      const maxAge = strategy.maxAgeSeconds * 1000;
      for (const [id, message] of this.messages.entries()) {
        if (now - message.timestamp > maxAge) {
          messagesToDelete.push(id);
        }
      }
    }

    // Remove duplicates
    const uniqueToDelete = [...new Set(messagesToDelete)];
    for (const id of uniqueToDelete) {
      this.messages.delete(id);
    }

    return uniqueToDelete.length;
  }

  async getMessages(
    start: string,
    end: string,
    count?: number
  ): Promise<Message<T>[]> {
    const allMessages = Array.from(this.messages.values()).sort(
      (a, b) => a.timestamp - b.timestamp
    );

    // Filter by ID range (lexicographic comparison)
    let filtered = allMessages.filter((m) => m.id >= start && m.id <= end);

    // Apply count limit if specified
    if (count !== undefined && count > 0) {
      filtered = filtered.slice(0, count);
    }

    return filtered;
  }

  /**
   * Replay messages from a specific timestamp
   */
  async replay(
    fromTimestamp: number,
    handler: MessageHandler<T>
  ): Promise<number> {
    const messages = Array.from(this.messages.values())
      .filter((m) => m.timestamp >= fromTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const message of messages) {
      await handler(message);
    }

    return messages.length;
  }

  /**
   * Get message count
   */
  getMessageCount(): number {
    return this.messages.size;
  }

  async close(): Promise<void> {
    this.messages.clear();
  }
}
