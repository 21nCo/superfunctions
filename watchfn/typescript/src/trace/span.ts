import { randomBytes } from "node:crypto";

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentId?: string;
  sampled: boolean;
}

export interface SpanOptions {
  name: string;
  parentId?: string;
  traceId?: string;
  startTime?: number;
  tags?: Record<string, any>;
}

export class Span {
  readonly id: string;
  readonly traceId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: number;
  
  endTime?: number;
  tags: Record<string, any> = {};
  logs: Array<{ timestamp: number; fields: Record<string, any> }> = [];

  constructor(options: SpanOptions, private readonly onFinish?: (span: Span) => void) {
    this.id = randomBytes(8).toString("hex");
    this.traceId = options.traceId || randomBytes(16).toString("hex");
    this.parentId = options.parentId;
    this.name = options.name;
    this.startTime = options.startTime ?? Date.now();
    this.tags = options.tags || {};
  }

  setTag(key: string, value: any) {
    this.tags[key] = value;
    return this;
  }

  log(fields: Record<string, any>) {
    this.logs.push({
      timestamp: Date.now(),
      fields,
    });
    return this;
  }

  finish(endTime: number = Date.now()) {
    if (this.endTime !== undefined) return this;
    this.endTime = endTime;
    this.onFinish?.(this);
    return this;
  }

  getContext(): SpanContext {
    return {
      traceId: this.traceId,
      spanId: this.id,
      parentId: this.parentId,
      sampled: true,
    };
  }
  
  toJSON() {
      return {
          id: this.id,
          traceId: this.traceId,
          parentId: this.parentId,
          name: this.name,
          startTime: this.startTime,
          endTime: this.endTime,
          duration: this.endTime !== undefined ? this.endTime - this.startTime : undefined,
          tags: this.tags,
          logs: this.logs
      };
  }
}
