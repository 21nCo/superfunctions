import type { RetentionPageOptions, RetentionPageResult } from "../storage/event-retention";
import type { WatchFnDatabase } from "../storage/database";
import type { BotFnIssueConfig } from "../integrations/botfn/types";
import { z } from "zod";

export const WatchFnConfigSchema = z.object({
  name: z.string(),
  projectId: z.string().optional(),
  storage: z.union([
    z.literal("memory"),
    z.literal("database"),
    z.literal("hybrid"),
    z.object({
      type: z.literal("hybrid"),
      tiers: z.array(z.any()).optional(),
    }),
  ]).optional().default("memory"),
  
  database: z.custom<WatchFnDatabase>().optional(),
  retention: z.object({
    apps: z.array(z.string().min(1).max(200).refine(value => !!value.trim())).min(1).max(100),
    defaultTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    bugReportTtlMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  }).optional(),
  botfn: z.custom<BotFnIssueConfig>(value => !!value && typeof value === "object" && !Array.isArray(value)).optional(),
  
  apm: z.object({
    enabled: z.boolean().default(true),
    autoInstrument: z.object({
      http: z.boolean().default(true),
      database: z.boolean().default(true),
      redis: z.boolean().default(true),
      external: z.boolean().default(true),
    }).optional(),
    sampleRate: z.number().min(0).max(1).default(1.0),
    slowRequestThreshold: z.number().default(1000),
  }).optional(),

  errors: z.object({
    enabled: z.boolean().default(true),
    captureUnhandled: z.boolean().default(true),
    captureRejections: z.boolean().default(true),
    ignoreErrors: z.array(z.union([z.string(), z.instanceof(RegExp)])).optional(),
  }).optional(),

  trace: z.object({
    enabled: z.boolean().default(true),
    sampleRate: z.number().default(0.1),
    serviceName: z.string().optional(),
  }).optional(),
  
  infra: z.object({
      enabled: z.boolean().default(true),
      interval: z.number().default(30000),
      system: z.boolean().default(true),
      process: z.boolean().default(true),
  }).optional(),

  integrations: z.record(z.any()).optional(),
  
  auth: z.object({
      enabled: z.boolean().optional(),
      apiKey: z.string().optional(),
      allowedOrigins: z.array(z.string()).optional(),
  }).optional(),
});

export type WatchFnConfig = z.infer<typeof WatchFnConfigSchema>;

export interface WatchFnInstance {
  start(): void;
  stop(): Promise<void>;
  flush(): Promise<void>;
  cleanupRetention(options?: RetentionPageOptions): Promise<RetentionPageResult>;
  track(event: string, properties?: Record<string, any>): void;
  captureException(error: any, context?: Record<string, any>): void;
  captureMessage(message: string, context?: Record<string, any>): void;
  // Add other methods as per spec
  query(params: any): Promise<any>;
}
