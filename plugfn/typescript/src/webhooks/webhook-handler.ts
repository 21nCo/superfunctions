import type { WebhookEvent, TriggerHandler } from '../types/trigger.js';
import type { Logger } from '../types/action.js';
import { ProviderRegistry } from '../core/provider-registry.js';

/**
 * Webhook handler manages incoming webhooks
 */
export class WebhookHandler {
  private handlers = new Map<string, Set<TriggerHandler>>();

  constructor(
    private providerRegistry: ProviderRegistry,
    private logger: Logger
  ) {}

  /**
   * Handle incoming webhook
   */
  async handleWebhook(
    provider: string,
    event: string,
    payload: any,
    headers: Record<string, string>,
    secret?: string
  ): Promise<WebhookEvent> {
    const providerObj = this.providerRegistry.get(provider);
    if (!providerObj) {
      throw new Error(`Provider ${provider} not found`);
    }

    // Find trigger
    const trigger = providerObj.triggers?.[event];
    if (!trigger) {
      throw new Error(`Trigger ${event} not found in provider ${provider}`);
    }

    // Verify signature if configured
    let verified = false;
    const signature = headers['x-signature'] || headers['x-hub-signature'] || '';

    if (trigger.webhookConfig?.verifySignature && secret) {
      try {
        verified = await trigger.webhookConfig.verifySignature(payload, signature, secret);
      } catch (error) {
        this.logger.error(`Webhook signature verification failed for ${provider}.${event}`, { error });
        throw new Error('Webhook signature verification failed');
      }
    } else {
      // If no verification configured, consider it verified
      verified = true;
    }

    // Transform payload if needed
    const transformedPayload = trigger.webhookConfig?.transformPayload
      ? trigger.webhookConfig.transformPayload(payload)
      : payload;

    // Create webhook event
    const webhookEvent: WebhookEvent = {
      id: this.generateEventId(),
      provider,
      event,
      payload: transformedPayload,
      signature,
      receivedAt: new Date(),
      verified,
      headers,
    };

    // Parse and handle event
    try {
      const triggerEvent = await trigger.handler(transformedPayload);
      
      // Emit to registered handlers
      await this.emit(provider, event, { ...triggerEvent, ...webhookEvent });
      
      this.logger.info(`Webhook handled: ${provider}.${event}`, { verified });
    } catch (error) {
      this.logger.error(`Webhook handling failed: ${provider}.${event}`, { error });
      throw error;
    }

    return webhookEvent;
  }

  /**
   * Register a webhook handler
   */
  on(provider: string, event: string, handler: TriggerHandler): void {
    const key = `${provider}:${event}`;
    
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    
    this.handlers.get(key)!.add(handler);
    this.logger.debug(`Handler registered for ${provider}.${event}`);
  }

  /**
   * Unregister a webhook handler
   */
  off(provider: string, event: string, handler: TriggerHandler): void {
    const key = `${provider}:${event}`;
    const handlers = this.handlers.get(key);
    
    if (handlers) {
      handlers.delete(handler);
      
      if (handlers.size === 0) {
        this.handlers.delete(key);
      }
    }
  }

  /**
   * Emit event to all registered handlers
   */
  private async emit(provider: string, event: string, webhookEvent: any): Promise<void> {
    const key = `${provider}:${event}`;
    const handlers = this.handlers.get(key);
    
    if (!handlers || handlers.size === 0) {
      this.logger.debug(`No handlers registered for ${provider}.${event}`);
      return;
    }
    
    const promises: Promise<void>[] = [];
    
    for (const handler of handlers) {
      promises.push(
        Promise.resolve(handler(webhookEvent)).catch((error) => {
          this.logger.error(`Handler error for ${provider}.${event}`, { error });
        })
      );
    }
    
    await Promise.all(promises);
  }

  /**
   * Get registered handlers count
   */
  getHandlerCount(provider?: string, event?: string): number {
    if (provider && event) {
      const key = `${provider}:${event}`;
      return this.handlers.get(key)?.size || 0;
    }
    
    let total = 0;
    for (const handlers of this.handlers.values()) {
      total += handlers.size;
    }
    return total;
  }

  /**
   * Clear all handlers
   */
  clearHandlers(): void {
    this.handlers.clear();
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

