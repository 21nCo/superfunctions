export interface StreamOptions {
    maxLength?: number;
    retention?: number;
    partitions?: number;
}

export interface Stream<T = any> {
  name: string;
  
  // Publishing
  publish(data: T, options?: PublishOptions): Promise<string>;
  publishBatch(messages: Array<{ data: T; options?: PublishOptions }>): Promise<string[]>;
  
  // Subscribing
  subscribe(handler: MessageHandler<T>, options?: SubscribeOptions): Promise<Subscription>;
  createConsumer(consumerId: string, options: ConsumerOptions): Consumer<T>;
  
  // Management
  getInfo(): Promise<StreamInfo>;
  trim(strategy: TrimStrategy): Promise<number>;
  getMessages(start: string, end: string, count?: number): Promise<Message<T>[]>;
  
  // Lifecycle
  close(): Promise<void>;
}

export interface Message<T = any> {
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

export interface SubscribeOptions {
    // Basic subscription options if any
}

export interface ConsumerOptions {
  groupId: string;
  fromBeginning?: boolean;
  autoCommit?: boolean;
  commitInterval?: number;
  maxInFlight?: number;
}

export interface Consumer<T = any> {
  subscribe(handler: MessageHandler<T>): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export type MessageHandler<T> = (message: Message<T>) => Promise<void>;

export interface Subscription {
    unsubscribe(): Promise<void>;
}

export interface StreamInfo {
    name: string;
    length: number;
    groups: number;
}

export interface TrimStrategy {
    maxLength?: number;
    maxAgeSeconds?: number;
}
