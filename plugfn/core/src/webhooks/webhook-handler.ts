import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type {
  ScopedTriggerHandler,
  Trigger,
  TriggerHandler,
  WebhookConfig,
  WebhookEvent,
  WebhookVerificationContext,
  WebhookWorkflowBinding,
  WebhookWorkflowBindingMatch,
} from '../types/trigger.js';
import type { WebhookOptions } from '../types/config.js';
import type { PlugFnWebhookDelivery, PlugFnWebhookReceipt } from '../types/runtime.js';
import type { Logger } from '../types/action.js';
import { ProviderRegistry } from '../core/provider-registry.js';

interface VerifiedWebhook {
  triggerKey: string;
  trigger: Trigger;
  transformedPayload: any;
  normalizedHeaders: Record<string, string>;
  signature: string;
  verified: boolean;
}

interface PreparedWebhook extends VerifiedWebhook {
  signatureVerified: boolean;
}

export interface WebhookAdmission {
  signatureVerified: boolean;
  binding?: Readonly<WebhookWorkflowBinding>;
  idempotencyKey?: string;
  payloadHash?: string;
  assertActive?(): void;
  event(): WebhookEvent;
  dispatch(): Promise<WebhookEvent>;
}

interface WebhookDispatchScope {
  binding: Readonly<WebhookWorkflowBinding>;
  idempotencyKey: string;
  authenticatedDeliveryId?: string;
  bindingIsCurrent(): Promise<boolean>;
  revoked: AbortSignal;
  /** Undefined shares the workflow trigger. Null means a separate route has no listener. */
  standalone?: PreparedWebhook | null;
}

/** Internal preparation used by the router. Public verification returns inspection data only. */
export const prepareWebhookDelivery = Symbol('plugfn.prepareWebhookDelivery');

type WebhookPreparation = WebhookHandler[typeof prepareWebhookDelivery];
type WebhookFacade = { handle: object; verify: object };
const webhookPreparations = new WeakMap<object, WebhookPreparation>();

export function registerWebhookPreparation(facade: WebhookFacade, prepare: WebhookPreparation, runtimeConfig?: object): void {
  webhookPreparations.set(facade, prepare);
  if (runtimeConfig) webhookPreparations.set(runtimeConfig, prepare);
  // Copies of the facade retain the original methods unless a caller wraps them.
  webhookPreparations.set(facade.handle, prepare);
  webhookPreparations.set(facade.verify, prepare);
}

export function prepareWebhookIngress(runtimeConfig: object, facade: WebhookFacade, ...args: Parameters<WebhookPreparation>): ReturnType<WebhookPreparation> {
  let prepare = webhookPreparations.get(facade);
  if (!prepare) {
    const byHandle = webhookPreparations.get(facade.handle);
    const byVerify = webhookPreparations.get(facade.verify);
    if (!byHandle || !byVerify || byHandle === byVerify) {
      prepare = webhookPreparations.get(runtimeConfig) ?? byHandle ?? byVerify;
    }
  }
  if (!prepare) {
    throw new WebhookHandlerError('PLUGFN_NOT_READY', 'webhook ingress is not initialized', 503);
  }
  return prepare(...args);
}

export function copyWebhookBody(body: Uint8Array): Uint8Array {
  const copy = Buffer.isBuffer(body) ? Buffer.alloc(body.byteLength) : new Uint8Array(body.byteLength);
  copy.set(body);
  return copy;
}

export class WebhookHandlerError extends Error {
  readonly code:
    | 'WEBHOOK_SECRET_NOT_FOUND'
    | 'WEBHOOK_SIGNATURE_INVALID'
    | 'WEBHOOK_SIGNATURE_REQUIRED'
    | 'WEBHOOK_WORKFLOW_BINDING_REQUIRED'
    | 'WEBHOOK_WORKFLOW_BINDING_REVOKED'
    | 'WEBHOOK_IDEMPOTENCY_CONFLICT'
    | 'WEBHOOK_DELIVERY_REASSIGNMENT_CONFLICT'
    | 'WEBHOOK_HANDLER_FAILED'
    | 'PLUGFN_NOT_READY'
    | 'VALIDATION_ERROR';
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: WebhookHandlerError['code'],
    message: string,
    status = 400,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'WebhookHandlerError';
    this.code = code;
    this.status = status;
    this.retryable = status >= 500;
    this.details = details;
  }
}

class WebhookPayloadValidationError extends WebhookHandlerError {
  constructor() {
    super('VALIDATION_ERROR', 'webhook payload validation failed');
  }
}

export class WebhookHandler {
  private handlers = new Map<string, Set<TriggerHandler>>();
  private workflowHandlers = new Map<string, Set<ScopedTriggerHandler>>();
  private processedEventIds = new Map<string, number>();
  private readonly maxProcessedEventIds = 10000;

  constructor(
    private providerRegistry: ProviderRegistry,
    private logger: Logger,
    private options: Pick<WebhookOptions, 'verifySignatures' | 'workflowBindings'> = {}
  ) {}

  async handleWebhook(
    provider: string,
    event: string,
    payload: any,
    headers: Record<string, string>,
    secret?: string,
    options: {
      rawBody?: Uint8Array;
    } = {}
  ): Promise<WebhookEvent> {
    const prepared = await this[prepareWebhookDelivery](provider, event, payload, headers, secret, options);
    const admission = await prepared.admit();
    if (admission.binding) {
      throw new WebhookHandlerError(
        'WEBHOOK_WORKFLOW_BINDING_REQUIRED',
        'scoped webhook delivery requires PlugFn.webhooks.handle',
        409
      );
    }
    return admission.dispatch();
  }

  async verifyWebhook(...args: Parameters<WebhookHandler[typeof prepareWebhookDelivery]>): Promise<VerifiedWebhook> {
    const { triggerKey, trigger, transformedPayload, normalizedHeaders, signature, verified } =
      await this[prepareWebhookDelivery](...args);
    return { triggerKey, trigger, transformedPayload, normalizedHeaders, signature, verified };
  }

  private async dispatchWebhook(
    provider: string,
    prepared: PreparedWebhook,
    scope?: WebhookDispatchScope,
  ): Promise<WebhookEvent> {
    const { triggerKey, trigger, transformedPayload, verified } = prepared;
    if (scope && (!(await scope.bindingIsCurrent()) || scope.revoked.aborted)) {
      throw webhookBindingRevoked();
    }

    const webhookEvent = this.createWebhookEvent(provider, prepared, scope);
    const { deliveryId: eventId, idempotencyKey } = webhookEvent;
    const dispatchWorkflowEvent = trigger.webhookConfig?.shouldDispatch?.(transformedPayload) !== false;
    if (!dispatchWorkflowEvent && !scope?.standalone) {
      this.logger.info(`Webhook dispatch skipped: ${provider}.${triggerKey}`);
      return webhookEvent;
    }

    const processedEventKey = idempotencyKey ?? null;
    if (processedEventKey && this.processedEventIds.has(processedEventKey)) {
      this.logger.info(`Webhook duplicate ignored: ${provider}.${triggerKey}`, { eventId });
      return webhookEvent;
    }

    if (dispatchWorkflowEvent) {
      const triggerEvent = await trigger.handler(transformedPayload);
      if (scope?.revoked.aborted) throw webhookBindingRevoked();
      await this.emit(
        provider, triggerKey, { ...triggerEvent, ...webhookEvent }, scope,
        trigger.webhookConfig?.cloneWorkflowEvent,
      );
    }
    if (scope?.standalone) {
      const standalone = scope.standalone;
      if (scope.revoked.aborted) throw webhookBindingRevoked();
      if (standalone.trigger.webhookConfig?.shouldDispatch?.(standalone.transformedPayload) !== false) {
        const standaloneEvent = this.createWebhookEvent(provider, standalone, scope);
        const triggerEvent = await standalone.trigger.handler(standalone.transformedPayload);
        if (scope.revoked.aborted) throw webhookBindingRevoked();
        await this.emit(provider, standalone.triggerKey, { ...triggerEvent, ...standaloneEvent }, undefined, undefined);
      }
    }

    if (processedEventKey) {
      this.rememberProcessedEvent(processedEventKey);
    }

    this.logger.info(`Webhook handled: ${provider}.${triggerKey}`, { verified, eventId });
    return webhookEvent;
  }

  private createWebhookEvent(provider: string, prepared: VerifiedWebhook, scope?: WebhookDispatchScope): WebhookEvent {
    const { triggerKey, transformedPayload, normalizedHeaders, signature, verified } = prepared;
    const eventId = scope ? scope.authenticatedDeliveryId : getEventId(transformedPayload, normalizedHeaders);
    const idempotencyKey = scope
      ? JSON.stringify([provider, scope.binding.tenantId, scope.binding.connectionId, scope.idempotencyKey])
      : eventId ? `${provider}:${eventId}` : undefined;

    return {
      id: this.generateEventId(),
      deliveryId: eventId,
      idempotencyKey,
      webhookDelivery: true,
      provider,
      event: triggerKey,
      payload: transformedPayload,
      signature,
      receivedAt: new Date(),
      verified,
      headers: normalizedHeaders,
    };

  }

  async [prepareWebhookDelivery](
    provider: string,
    event: string,
    payload: any,
    headers: Record<string, string>,
    secret?: string,
    options: {
      rawBody?: Uint8Array;
      standaloneEvent?: string;
    } = {}
  ): Promise<PreparedWebhook & { authenticatedWithoutSubject: boolean; admit(): Promise<WebhookAdmission> }> {
    const providerObj = this.providerRegistry.get(provider);
    if (!providerObj) {
      throw new WebhookHandlerError('VALIDATION_ERROR', `Provider ${provider} not found`, 404);
    }

    const { triggerKey, trigger } = this.resolveTrigger(provider, event, providerObj.triggers ?? {});
    const normalizedHeaders = normalizeHeaders(headers);
    const signature = getSignature(provider, normalizedHeaders);
    const resolvers = this.options.workflowBindings;
    const requiresBinding = resolvers && Object.hasOwn(resolvers, provider);
    const authorities = requiresBinding ? resolvers[provider] : undefined;
    if (requiresBinding && !options.rawBody?.length) {
      throw webhookBindingRequired('webhook providers with workflow bindings require the original raw body');
    }
    if (requiresBinding && this.options.verifySignatures === false) {
      throw webhookBindingRequired('webhook providers with workflow bindings require signature verification enabled');
    }
    // Scoped delivery must extract and dispatch from the same bytes the verifier sees.
    const rawBody = requiresBinding && options.rawBody ? copyWebhookBody(options.rawBody) : options.rawBody;
    const parsedPayload = requiresBinding || payload == null ? parseWebhookPayload(rawBody) : payload;
    const verificationContext: WebhookVerificationContext = {
      rawBody,
      headers: normalizedHeaders,
    };

    const verifier = trigger.webhookConfig?.verifySignature;
    if (this.options.verifySignatures === true && !verifier) {
      throw new WebhookHandlerError(
        'WEBHOOK_SIGNATURE_REQUIRED',
        `signature verifier not configured for ${provider}.${triggerKey}`,
        500
      );
    }

    let verified = this.options.verifySignatures !== false;
    let signatureVerified = false;
    if (this.options.verifySignatures !== false && verifier) {
      if (!secret) {
        throw new WebhookHandlerError('WEBHOOK_SECRET_NOT_FOUND', `secret not configured for ${provider}`);
      }

      try {
        verified = await verifier(
          parsedPayload,
          signature,
          secret,
          verificationContext
        );
      } catch (error) {
        this.logger.error(`Webhook signature verification failed for ${provider}.${triggerKey}`, { error });
        throw new WebhookHandlerError('WEBHOOK_SIGNATURE_INVALID', 'signature verification failed');
      }

      if (!verified) {
        throw new WebhookHandlerError('WEBHOOK_SIGNATURE_INVALID', 'signature verification failed');
      }
      signatureVerified = verified === true;
    }

    const authenticated = Boolean(rawBody?.length && signatureVerified && secret);
    const subject = requiresBinding && authenticated
      ? trigger.webhookConfig?.getWorkflowSubject?.(parsedPayload, verificationContext)
      : undefined;
    if (requiresBinding && authenticated && subject === undefined && options.standaloneEvent !== undefined && options.standaloneEvent !== event) {
      const standalone = await this[prepareWebhookDelivery](
        provider, options.standaloneEvent, payload, headers, secret, { rawBody },
      );
      // Both triggers must agree that the verified delivery has no workflow subject.
      if (!standalone.authenticatedWithoutSubject) {
        throw webhookBindingRequired();
      }
      return standalone;
    }
    const workflowEvent = isBindingId(subject)
      ? trigger.webhookConfig?.getWorkflowEvent?.(parsedPayload, verificationContext)
      : undefined;
    const authenticatedDeliveryId = isBindingId(subject)
      ? trigger.webhookConfig?.getAuthenticatedDeliveryId?.(parsedPayload, verificationContext)
      : undefined;
    const payloadHash = isBindingId(subject) && rawBody ? sha256(rawBody) : undefined;
    const credentialFingerprint = requiresBinding && authenticated && secret ? sha256(secret) : undefined;
    const transformedPayload = trigger.webhookConfig?.transformPayload
      ? trigger.webhookConfig.transformPayload(parsedPayload)
      : parsedPayload;
    if (requiresBinding) {
      if (!trigger.schema.safeParse(transformedPayload).success) throw new WebhookPayloadValidationError();
    } else {
      try {
        trigger.schema.parse(transformedPayload);
      } catch {
        throw new WebhookPayloadValidationError();
      }
    }

    const prepared = {
      triggerKey,
      trigger,
      transformedPayload,
      normalizedHeaders,
      signature,
      verified,
      signatureVerified,
    };
    const authenticatedWithoutSubject = Boolean(requiresBinding && authenticated && subject === undefined);
    return {
      ...prepared,
      authenticatedWithoutSubject,
      admit: async () => {
        if (!requiresBinding || (authenticatedWithoutSubject && this.getHandlerCount(provider, triggerKey) > 0)) {
          return {
            signatureVerified,
            dispatch: () => this.dispatchWebhook(provider, prepared),
            event: () => this.createWebhookEvent(provider, prepared),
          };
        }
        if (!credentialFingerprint || !isBindingId(subject) || !payloadHash) {
          throw webhookBindingRequired();
        }
        if (workflowEvent !== triggerKey) {
          throw new WebhookHandlerError(
            'VALIDATION_ERROR',
            'webhook event does not match the authenticated payload'
          );
        }
        const matchingAuthorities = authorities?.filter(({ credentialFingerprints }) =>
          credentialFingerprints.includes(credentialFingerprint)
        );
        if (matchingAuthorities?.length !== 1 || !isBindingId(matchingAuthorities[0].id)) {
          throw webhookBindingRequired();
        }
        const authority = matchingAuthorities[0];
        if (authorities?.filter(({ id }) => id === authority.id).length !== 1) {
          throw webhookBindingRequired();
        }

        const resolveUniqueBinding = async (): Promise<WebhookWorkflowBindingMatch | undefined> => {
          let candidates: readonly WebhookWorkflowBindingMatch[];
          try {
            candidates = await authority.resolve(subject);
          } catch {
            throw new WebhookHandlerError(
              'WEBHOOK_HANDLER_FAILED',
              'webhook binding resolution failed',
              503
            );
          }
          return Array.isArray(candidates) && candidates.length === 1 && isWorkflowBinding(candidates[0])
            ? candidates[0]
            : undefined;
        };
        const match = await resolveUniqueBinding();
        if (!match) {
          throw webhookBindingRequired();
        }
        const { tenantId, connectionId, revoked } = match;
        const binding = Object.freeze({ tenantId, connectionId });
        const deliveryId = isBindingId(authenticatedDeliveryId) ? authenticatedDeliveryId : undefined;
        const deliveryIdentity = deliveryId
          ? ['delivery', deliveryId]
          : ['payload', workflowEvent, payloadHash];
        const idempotencyKey = sha256(JSON.stringify([authority.id, subject, ...deliveryIdentity]));
        const bindingIsCurrent = async () => {
          const current = await resolveUniqueBinding();
          return current?.tenantId === tenantId &&
            current.connectionId === connectionId &&
            current.revoked === revoked &&
            !revoked.aborted;
        };
        const scope: WebhookDispatchScope = {
          binding, idempotencyKey, authenticatedDeliveryId: deliveryId, bindingIsCurrent, revoked,
        };
        const standaloneEvent = options.standaloneEvent;
        if (standaloneEvent !== undefined && standaloneEvent !== event) {
          let legacyKey: string | undefined;
          try {
            legacyKey = this.resolveTrigger(provider, standaloneEvent, providerObj.triggers ?? {}).triggerKey;
          } catch (error) {
            if (!(error instanceof WebhookHandlerError) || error.status !== 404) throw error;
          }
          if (legacyKey !== triggerKey) {
            scope.standalone = null;
            if (legacyKey && this.getHandlerCount(provider, legacyKey) > 0) {
              try {
                const legacy = await this[prepareWebhookDelivery](
                  provider, standaloneEvent, payload, headers, secret, { rawBody: options.rawBody },
                );
                if (!legacy.signatureVerified) {
                  throw new WebhookHandlerError(
                    'WEBHOOK_SIGNATURE_REQUIRED', `signature verifier not configured for ${provider}.${legacyKey}`, 500,
                  );
                }
                scope.standalone = legacy;
              } catch (error) {
                if (!(error instanceof WebhookPayloadValidationError)) throw error;
                this.logger.warn(`Standalone webhook payload did not match ${provider}.${legacyKey}`);
              }
            }
          }
        }
        return {
          signatureVerified,
          binding,
          idempotencyKey,
          payloadHash,
          assertActive: () => {
            if (revoked.aborted) {
              throw webhookBindingRevoked();
            }
          },
          dispatch: () => this.dispatchWebhook(provider, prepared, scope),
          event: () => this.createWebhookEvent(provider, prepared, scope),
        };
      },
    };
  }

  on(provider: string, event: string, handler: TriggerHandler): void {
    const key = handlerKey(provider, event);

    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }

    this.handlers.get(key)!.add(handler);
    this.logger.debug(`Handler registered for ${provider}.${event}`);
  }

  off(provider: string, event: string, handler: TriggerHandler): void {
    const key = handlerKey(provider, event);
    const handlers = this.handlers.get(key);

    if (handlers) {
      handlers.delete(handler);

      if (handlers.size === 0) {
        this.handlers.delete(key);
      }
    }
  }

  onWorkflow(provider: string, event: string, binding: WebhookWorkflowBinding, handler: ScopedTriggerHandler): void {
    const key = handlerKey(provider, event, binding);
    let handlers = this.workflowHandlers.get(key);
    if (!handlers) {
      handlers = new Set();
      this.workflowHandlers.set(key, handlers);
    }
    handlers.add(handler);
  }

  offWorkflow(provider: string, event: string, binding: WebhookWorkflowBinding, handler: ScopedTriggerHandler): void {
    const key = handlerKey(provider, event, binding);
    const handlers = this.workflowHandlers.get(key);
    handlers?.delete(handler);
    if (handlers?.size === 0) {
      this.workflowHandlers.delete(key);
    }
  }

  getHandlerCount(provider?: string, event?: string, binding?: WebhookWorkflowBinding): number {
    if (provider && event) {
      const key = handlerKey(provider, event, binding);
      return (binding ? this.workflowHandlers : this.handlers).get(key)?.size ?? 0;
    }

    let total = 0;
    for (const handlers of this.handlers.values()) {
      total += handlers.size;
    }
    for (const handlers of this.workflowHandlers.values()) {
      total += handlers.size;
    }
    return total;
  }

  clearHandlers(): void {
    this.handlers.clear();
    this.workflowHandlers.clear();
  }

  getProcessedEventCacheSize(): number {
    return this.processedEventIds.size;
  }

  private rememberProcessedEvent(idempotencyKey: string): void {
    this.processedEventIds.set(idempotencyKey, Date.now());
    if (this.processedEventIds.size <= this.maxProcessedEventIds) {
      return;
    }

    const overflow = this.processedEventIds.size - this.maxProcessedEventIds;
    const oldestKeys = [...this.processedEventIds.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(0, overflow)
      .map(([key]) => key);
    for (const key of oldestKeys) {
      this.processedEventIds.delete(key);
    }
  }

  private async emit(
    provider: string,
    event: string,
    webhookEvent: Parameters<TriggerHandler>[0],
    scope: WebhookDispatchScope | undefined,
    cloneWorkflowEvent: WebhookConfig['cloneWorkflowEvent'],
  ): Promise<void> {
    const listeners = scope?.standalone === undefined ? this.handlers.get(handlerKey(provider, event)) : undefined;
    const workflowHandlers = scope && this.workflowHandlers.get(handlerKey(provider, event, scope.binding));
    if (!listeners?.size && !workflowHandlers?.size) {
      this.logger.debug(`No handlers registered for ${provider}.${event}`);
      return;
    }

    if (scope && workflowHandlers) {
      const copyEvent = cloneWorkflowEvent
        ? () => cloneWorkflowEvent(webhookEvent)
        : snapshotWorkflowEvent(webhookEvent);
      const calls = [...workflowHandlers].map((handler) =>
        Promise.resolve().then(() => handler(copyEvent(), scope))
      );
      await this.settleHandlers(provider, event, calls);
    }
    // A scoped workflow failure must leave listeners untouched for the next attempt.
    if (scope?.revoked.aborted) {
      throw webhookBindingRevoked();
    }
    const listenerCalls = [...(listeners ?? [])].map((handler) =>
      Promise.resolve().then(() => handler({ ...webhookEvent }))
    );
    await this.settleHandlers(provider, event, listenerCalls);
  }

  private async settleHandlers(provider: string, event: string, calls: Promise<void>[]): Promise<void> {
    const results = await Promise.allSettled(calls);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );

    for (const failure of failures) {
      this.logger.error(`Handler error for ${provider}.${event}`, { error: failure.reason });
    }

    const revoked = failures.find(({ reason }) =>
      reason instanceof WebhookHandlerError && reason.code === 'WEBHOOK_WORKFLOW_BINDING_REVOKED'
    );
    if (revoked) {
      throw revoked.reason;
    }
    if (failures.length > 0) {
      throw new WebhookHandlerError(
        'WEBHOOK_HANDLER_FAILED',
        'webhook handler failed',
        503
      );
    }
  }

  private resolveTrigger(
    provider: string,
    incomingEvent: string,
    triggers: Record<string, Trigger>
  ): { triggerKey: string; trigger: Trigger } {
    const canonicalEvent = canonicalizeEvent(incomingEvent);
    const eventMap = new Map<string, string>();

    for (const [triggerKey, trigger] of Object.entries(triggers)) {
      const normalizedTriggerKey = canonicalizeEvent(triggerKey);
      setEventMapping(eventMap, normalizedTriggerKey, triggerKey);

      const path = trigger.webhookConfig?.path;
      if (typeof path === 'string' && path.length > 0) {
        const normalizedPathKey = canonicalizeEvent(path);
        setEventMapping(eventMap, normalizedPathKey, triggerKey);
        const routeSuffix = webhookRouteSuffix(provider, path);
        if (routeSuffix) {
          setEventMapping(eventMap, canonicalizeEvent(routeSuffix), triggerKey);
        }
      }
    }

    const resolvedTriggerKey = eventMap.get(canonicalEvent);
    if (!resolvedTriggerKey) {
      throw new WebhookHandlerError(
        'VALIDATION_ERROR',
        `unknown webhook event: ${provider}.${incomingEvent}`,
        404
      );
    }

    const trigger = triggers[resolvedTriggerKey];
    if (!trigger) {
      throw new WebhookHandlerError(
        'VALIDATION_ERROR',
        `Trigger ${resolvedTriggerKey} not found in provider ${provider}`,
        404
      );
    }

    return {
      triggerKey: resolvedTriggerKey,
      trigger,
    };
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

function snapshotWorkflowEvent(event: Parameters<TriggerHandler>[0]): () => Parameters<TriggerHandler>[0] {
  const snapshot = serialize(event);
  return () => {
    // Deserialized buffers can retain the backing store of the serialized input.
    const copy = Buffer.alloc(snapshot.length);
    snapshot.copy(copy);
    return deserialize(copy);
  };
}

export function isBindingId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWorkflowBinding(value: WebhookWorkflowBindingMatch | undefined): value is WebhookWorkflowBindingMatch {
  return Boolean(value && isBindingId(value.tenantId) && isBindingId(value.connectionId) &&
    value.revoked instanceof AbortSignal && !value.revoked.aborted);
}

function handlerKey(provider: string, event: string, binding?: WebhookWorkflowBinding): string {
  return JSON.stringify([provider, event, binding?.tenantId, binding?.connectionId]);
}

export function webhookBindingRequired(message = 'webhook has no unique verified workflow binding'): WebhookHandlerError {
  return new WebhookHandlerError(
    'WEBHOOK_WORKFLOW_BINDING_REQUIRED',
    message,
    403
  );
}

export function webhookBindingRevoked(): WebhookHandlerError {
  return new WebhookHandlerError(
    'WEBHOOK_WORKFLOW_BINDING_REVOKED',
    'webhook workflow binding changed before execution',
    503
  );
}

export function assertWebhookReceiptScope(
  receipt: PlugFnWebhookReceipt,
  binding: WebhookWorkflowBinding | undefined
): void {
  if (
    Boolean(receipt.workflowIdempotencyKey) !== Boolean(binding) ||
    (binding && (receipt.workflowTenantId !== binding.tenantId || receipt.connectionId !== binding.connectionId))
  ) {
    throw new WebhookHandlerError(
      'WEBHOOK_IDEMPOTENCY_CONFLICT',
      'webhook idempotency key conflicts with another delivery',
      409
    );
  }
}

export function assertWebhookReceiptProvider(
  receipt: PlugFnWebhookReceipt,
  provider: string | undefined,
): void {
  if (receipt.workflowIdempotencyKey && provider !== undefined && provider !== receipt.provider) {
    throw new WebhookHandlerError('WEBHOOK_IDEMPOTENCY_CONFLICT', 'scoped webhook receipt provider cannot be changed', 409);
  }
}

export function hasWebhookSignatureProof(record: { signatureVerified?: unknown }): boolean {
  // MySQL drivers can return BOOLEAN columns as TINYINT values on readback.
  return record.signatureVerified === true || record.signatureVerified === 1;
}

export function normalizeWebhookStorageRow<T extends PlugFnWebhookReceipt | PlugFnWebhookDelivery | null>(row: T): T {
  if (!row) return row;
  const normalizeFlag = (value: unknown): true | null | undefined =>
    value === undefined ? undefined : value === true || value === 1 ? true : null;
  const signatureVerified = normalizeFlag(row.signatureVerified);
  const workflowScoped = 'workflowScoped' in row ? normalizeFlag(row.workflowScoped) : undefined;
  if (signatureVerified === row.signatureVerified &&
      (!('workflowScoped' in row) || workflowScoped === row.workflowScoped)) return row;
  return {
    ...row,
    ...(signatureVerified !== undefined ? { signatureVerified } : {}),
    ...(workflowScoped !== undefined ? { workflowScoped } : {}),
  };
}

const retryBookkeepingFields = new Set([
  'status', 'attempts', 'claimToken', 'nextAttemptAt', 'error', 'metadata', 'updatedAt',
]);

const receiptUpdateFields = new Set([
  'id', 'provider', 'event', 'idempotencyKey', 'workflowIdempotencyKey', 'workflowTenantId',
  'connectionId', 'ownerKind', 'ownerId', 'headersRedacted', 'payloadHash', 'verificationStatus',
  'signatureVerified', 'receivedAt', 'createdAt', 'metadata',
]);
const deliveryUpdateFields = new Set([
  'id', 'receiptId', 'sinkId', 'handlerName', 'workflowScoped', 'signatureVerified', 'createdAt',
  ...retryBookkeepingFields,
]);

export function assertWebhookUpdateFields(updates: object, record: 'receipt' | 'delivery'): void {
  const allowed = record === 'receipt' ? receiptUpdateFields : deliveryUpdateFields;
  if (Object.keys(updates).some((field) => !allowed.has(field))) {
    throw new WebhookHandlerError('VALIDATION_ERROR', `unsupported webhook ${record} update field`, 400);
  }
}

export function webhookRetryUpdates(updates: Partial<PlugFnWebhookDelivery>): Partial<PlugFnWebhookDelivery> {
  return Object.fromEntries(Object.entries(updates).filter(([field]) => retryBookkeepingFields.has(field)));
}

export function webhookDeliveryReassignmentConflict(): WebhookHandlerError {
  return new WebhookHandlerError(
    'WEBHOOK_DELIVERY_REASSIGNMENT_CONFLICT', 'scoped webhook deliveries cannot change receipts', 409,
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function setEventMapping(eventMap: Map<string, string>, canonicalEvent: string, triggerKey: string): void {
  const existing = eventMap.get(canonicalEvent);
  if (!existing) {
    eventMap.set(canonicalEvent, triggerKey);
  }
}

function canonicalizeEvent(event: string): string {
  const decodedEvent = decodeURIComponent(event);
  let start = 0;
  let end = decodedEvent.length;

  while (start < end && decodedEvent.charCodeAt(start) === 47) {
    start += 1;
  }
  while (end > start && decodedEvent.charCodeAt(end - 1) === 47) {
    end -= 1;
  }

  return decodedEvent.slice(start, end).split('/').join('.').trim().toLowerCase();
}

function webhookRouteSuffix(provider: string, path: string): string | undefined {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const prefix = `/webhooks/${provider}/`;
  if (!normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
    return undefined;
  }

  const suffix = normalizedPath.slice(prefix.length);
  return suffix.length > 0 ? suffix : undefined;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function getSignature(provider: string, headers: Record<string, string>): string {
  const providerHeaderCandidates: Record<string, string[]> = {
    stripe: ['stripe-signature'],
    github: ['x-hub-signature-256', 'x-hub-signature'],
    linear: ['linear-signature', 'x-linear-signature', 'x-signature'],
    clickup: ['x-signature', 'clickup-signature'],
    gmail: ['x-goog-signature-256', 'x-goog-signature', 'x-signature'],
    slack: ['x-slack-signature'],
  };

  const sharedCandidates = ['x-signature', 'x-hub-signature', 'x-hub-signature-256'];
  const candidates = [...(providerHeaderCandidates[provider] ?? []), ...sharedCandidates];

  for (const header of candidates) {
    const signature = headers[header];
    if (signature) {
      return signature;
    }
  }

  return '';
}

function parseWebhookPayload(rawBody?: Uint8Array): any {
  if (!rawBody || rawBody.byteLength === 0) {
    return {};
  }

  const rawText = new TextDecoder().decode(rawBody);
  if (rawText.length === 0) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new WebhookHandlerError('VALIDATION_ERROR', 'invalid webhook payload', 400);
  }
}

function getEventId(payload: any, headers: Record<string, string>): string | undefined {
  for (const header of ['x-event-id', 'x-github-delivery', 'stripe-event-id']) {
    const value = headers[header];
    if (value) {
      return value;
    }
  }

  const payloadId = payload && typeof payload === 'object' ? payload.id : undefined;
  if (typeof payloadId === 'string' && payloadId.length > 0) {
    return payloadId;
  }

  if (headers['x-request-id']) return headers['x-request-id'];

  return undefined;
}
