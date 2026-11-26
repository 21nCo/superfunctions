import { z } from 'zod';

/**
 * Trigger type
 */
export enum TriggerType {
  Webhook = 'webhook',
  Polling = 'polling',
}

/**
 * Webhook configuration
 */
export interface WebhookVerificationContext {
  rawBody?: Uint8Array;
  headers: Record<string, string>;
}

export interface WebhookWorkflowBinding {
  tenantId: string;
  connectionId: string;
}

export interface WebhookWorkflowBindingMatch extends WebhookWorkflowBinding {
  /** Stable for this binding generation. The authority must abort it on revocation. */
  revoked: AbortSignal;
}

export interface WebhookConfig {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  verifySignature?: (
    payload: any,
    signature: string,
    secret: string,
    context: WebhookVerificationContext
  ) => Promise<boolean> | boolean;
  /** Extract a subject authenticated by verifySignature. */
  getWorkflowSubject?: (payload: unknown, context: WebhookVerificationContext) => string | undefined;
  /** Identify the unambiguous workflow event from authenticated data. */
  getWorkflowEvent?: (payload: unknown, context: WebhookVerificationContext) => string | undefined;
  /** Extract a delivery ID only when the verifier authenticates that ID. */
  getAuthenticatedDeliveryId?: (payload: unknown, context: WebhookVerificationContext) => string | undefined;
  transformPayload?: (payload: any) => any;
  shouldDispatch?: (payload: any) => boolean;
}

/**
 * Polling configuration
 */
export interface PollingConfig {
  interval: number; // milliseconds
  action: string;
  compareField?: string;
}

/**
 * Trigger definition
 */
export interface Trigger<TPayload = any> {
  name: string;
  displayName: string;
  description: string;
  type: TriggerType;
  webhookConfig?: WebhookConfig;
  pollingConfig?: PollingConfig;
  schema: z.ZodSchema<TPayload>;
  handler: (payload: any) => Promise<TriggerEvent<TPayload>>;
}

/**
 * Webhook event
 */
export interface WebhookEvent {
  id: string;
  /** Durable provider delivery identity. Undefined when the provider supplies none. */
  deliveryId?: string;
  /** Stable workflow admission key derived from provider and delivery identity. */
  idempotencyKey?: string;
  webhookDelivery: true;
  provider: string;
  event: string;
  payload: any;
  signature?: string;
  receivedAt: Date;
  verified: boolean;
  userId?: string;
  connectionId?: string;
  headers?: Record<string, string>;
}

/**
 * Trigger event emitted to handlers
 */
export interface TriggerEvent<TPayload = any> {
  event: string;
  data: TPayload;
  metadata?: Record<string, any>;
}

/**
 * Trigger handler function
 */
export type TriggerHandler<TPayload = any> = (
  event: TriggerEvent<TPayload> & WebhookEvent
) => Promise<void> | void;

/** Internal workflow dispatch also revalidates the installation registry after queued work. */
export type ScopedTriggerHandler = (
  event: Parameters<TriggerHandler>[0],
  admission: { bindingIsCurrent(): Promise<boolean>; revoked: AbortSignal }
) => Promise<void> | void;

/**
 * Polling trigger options
 */
export interface PollingTriggerOptions {
  provider: string;
  action: string;
  interval: number;
  params: Record<string, any>;
  onChange: (newItems: any[], prevItems: any[]) => Promise<void>;
  compareField?: string;
}
