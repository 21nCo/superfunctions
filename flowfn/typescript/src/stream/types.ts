import type { ShutdownOptions } from '../core/shutdown.js';
export interface StreamOptions {
  maxLength?: number;
  retention?: number;
  partitions?: number;
}

export interface Stream<T = any> {
  name: string;

  // Publishing
  publish(data: T, options?: PublishOptions): Promise<string>;
  publishBatch(
    messages: Array<{ data: T; options?: PublishOptions }>,
  ): Promise<string[]>;

  // Subscribing
  subscribe(
    handler: MessageHandler<T>,
    options?: SubscribeOptions<T>,
  ): Promise<Subscription>;
  createConsumer(consumerId: string, options: ConsumerOptions<T>): Consumer<T>;

  // Management
  getInfo(): Promise<StreamInfo>;
  /** Last observed local count; use getInfo() for authoritative backend length. */
  getMessageCount(): number;
  replay(timestamp: number, handler: MessageHandler<T>): Promise<number>;
  trim(strategy: TrimStrategy): Promise<number>;
  getMessages(
    start: string,
    end: string,
    count?: number,
  ): Promise<Message<T>[]>;

  // Lifecycle
  close(options?: ShutdownOptions): Promise<void>;
}

export interface Message<T = any> {
  /** Aborted when a durable consumer loses ownership or unsubscribes. */
  readonly signal?: AbortSignal;
  id: string;
  stream: string;
  data: T;
  headers?: Record<string, string>;
  timestamp: number;
  partition?: number;
  offset?: number;
  key?: string;

  ack(): Promise<void>;
  nack(requeue?: boolean): Promise<void>;
}

export interface PublishOptions {
  key?: string;
  headers?: Record<string, string>;
  partition?: number;
}

export type MessageFilter<T = any> = (message: Message<T>) => boolean | Promise<boolean>;

export interface SubscribeOptions<T = any> {
  filter?: MessageFilter<T>;
  fromBeginning?: boolean;
}

export interface ConsumerOptions<T = any> {
  /** False acknowledges the delivery for this group without invoking its handler. */
  filter?: MessageFilter<T>;
  groupId: string;
  fromBeginning?: boolean;
  autoCommit?: boolean;
  commitInterval?: number;
  maxInFlight?: number;
  /** Durable delivery lease; renewed while the consumer handler is running. */
  visibilityTimeout?: number;
}

export interface Consumer<T = any> {
  subscribe(handler: MessageHandler<T>): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(options?: ShutdownOptions): Promise<void>;
}

export type MessageHandler<T> = (message: Message<T>) => Promise<void>;

export interface Subscription {
  unsubscribe(): Promise<void>;
  pause?(): Promise<void>;
  resume?(): Promise<void>;
}

export interface StreamInfo {
  name: string;
  length: number;
  groups: number;
  /** Retained messages awaiting delivery or acknowledgment, summed across groups. */
  lag?: number;
}

export interface TrimStrategy {
  maxLength?: number;
  maxAgeSeconds?: number;
}
