# Multi-Payment Provider Support Approach

## Overview

BillFn should support multiple payment providers (Stripe, Dodo Payments, Polar, PayPal, Razorpay, etc.) simultaneously, allowing users to choose their preferred provider or use multiple providers for different use cases. This document outlines the architecture and approach for implementing multi-provider support.

## Core Design Principles

1. **Provider Abstraction**: All payment providers implement a common interface, abstracting away provider-specific differences
2. **Provider Registry**: Central registry manages available and configured providers
3. **Unified API**: BillFn exposes a single API that works across all providers
4. **Provider Selection**: Support for per-tenant/provider selection strategies
5. **Normalization**: Provider-specific responses normalized to common data structures
6. **Extensibility**: Easy to add new providers without modifying core code

## Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────────┐
│                    BillFn Core API                          │
│  (Subscriptions, Payments, Quotas, Usage)                  │
├─────────────────────────────────────────────────────────────┤
│              Payment Provider Manager                        │
│  ├── Provider Registry                                       │
│  ├── Provider Factory                                        │
│  └── Provider Selection Strategy                             │
├─────────────────────────────────────────────────────────────┤
│              Provider Adapters (Interfaces)                  │
│  ├── PaymentProvider                                        │
│  ├── SubscriptionProvider                                   │
│  └── WebhookProvider                                        │
├─────────────────────────────────────────────────────────────┤
│              Provider Implementations                        │
│  ├── StripeAdapter      ├── DodoAdapter                     │
│  ├── PolarAdapter        ├── PayPalAdapter                   │
│  └── RazorpayAdapter    └── ...                             │
└─────────────────────────────────────────────────────────────┘
```

## Core Interfaces

### 1. Payment Provider Interface

```typescript

export interface PaymentProvider {
  /**
   * Provider identifier (e.g., "stripe", "dodo", "polar")
   */
  readonly name: string;
  
  /**
   * Provider display name
   */
  readonly displayName: string;
  
  /**
   * Provider version
   */
  readonly version: string;
  
  /**
   * Supported capabilities
   */
  readonly capabilities: {
    subscriptions: boolean;
    oneTimePayments: boolean;
    refunds: boolean;
    webhooks: boolean;
    customerPortal: boolean;
    meteredBilling: boolean;
  };
  
  /**
   * Initialize the provider with configuration
   */
  initialize(config: PaymentProviderConfig): Promise<void>;
  
  /**
   * Check if provider is configured and ready
   */
  isConfigured(): boolean;
  
  /**
   * Health check
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}
```

### 2. Subscription Provider Interface

```typescript

export interface SubscriptionProvider extends PaymentProvider {
  /**
   * Create a subscription
   */
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>;
  
  /**
   * Get subscription by ID
   */
  getSubscription(subscriptionId: string): Promise<Subscription | null>;
  
  /**
   * Update subscription (plan, quantity, etc.)
   */
  updateSubscription(
    subscriptionId: string,
    updates: UpdateSubscriptionInput
  ): Promise<Subscription>;
  
  /**
   * Cancel subscription
   */
  cancelSubscription(
    subscriptionId: string,
    options?: CancelSubscriptionOptions
  ): Promise<Subscription>;
  
  /**
   * Resume cancelled subscription
   */
  resumeSubscription(subscriptionId: string): Promise<Subscription>;
  
  /**
   * List subscriptions for a customer
   */
  listSubscriptions(customerId: string): Promise<Subscription[]>;
  
  /**
   * Create checkout session for subscription
   */
  createCheckoutSession(
    input: CreateCheckoutSessionInput
  ): Promise<CheckoutSession>;
}
```

### 3. Payment Provider Interface

```typescript

export interface PaymentProvider extends PaymentProvider {
  /**
   * Create a payment intent
   */
  createPaymentIntent(
    input: CreatePaymentIntentInput
  ): Promise<PaymentIntent>;
  
  /**
   * Confirm payment
   */
  confirmPayment(
    paymentIntentId: string,
    options?: ConfirmPaymentOptions
  ): Promise<Payment>;
  
  /**
   * Create payment link
   */
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLink>;
  
  /**
   * Refund payment
   */
  refundPayment(
    paymentId: string,
    amount?: number,
    reason?: string
  ): Promise<Refund>;
  
  /**
   * Get payment status
   */
  getPaymentStatus(paymentId: string): Promise<PaymentStatus>;
}
```

### 4. Webhook Provider Interface

```typescript

export interface WebhookProvider {
  /**
   * Verify webhook signature
   */
  verifyWebhook(
    payload: string | Buffer,
    signature: string,
    secret: string
  ): boolean;
  
  /**
   * Parse webhook event
   */
  parseWebhookEvent(payload: unknown): WebhookEvent;
  
  /**
   * Get webhook event types supported
   */
  getSupportedEventTypes(): string[];
}
```

## Normalized Data Models

All providers return normalized data structures:

```typescript

export interface Subscription {
  id: string; // Provider subscription ID
  provider: string; // Provider name (e.g., "stripe", "dodo")
  customerId: string;
  planId: string;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete';
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  canceledAt?: Date;
  trialStart?: Date;
  trialEnd?: Date;
  metadata?: Record<string, string>;
  // Provider-specific data stored separately
  providerData?: Record<string, any>;
}

export interface Plan {
  id: string;
  provider: string;
  name: string;
  description?: string;
  amount: number; // In smallest currency unit (cents)
  currency: string;
  interval: 'day' | 'week' | 'month' | 'year';
  intervalCount: number;
  trialPeriodDays?: number;
  metadata?: Record<string, string>;
  providerData?: Record<string, any>;
}

export interface Payment {
  id: string;
  provider: string;
  customerId: string;
  amount: number;
  currency: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'canceled' | 'refunded';
  paymentMethod?: string;
  createdAt: Date;
  metadata?: Record<string, string>;
  providerData?: Record<string, any>;
}
```

## Provider Registry

```typescript

export class PaymentProviderRegistry {
  private providers = new Map<string, PaymentProvider>();
  private configuredProviders = new Map<string, PaymentProviderConfig>();
  
  /**
   * Register a payment provider
   */
  register(provider: PaymentProvider): void {
    this.providers.set(provider.name, provider);
  }
  
  /**
   * Get provider by name
   */
  get(name: string): PaymentProvider | undefined {
    return this.providers.get(name);
  }
  
  /**
   * Configure a provider
   */
  async configure(
    name: string,
    config: PaymentProviderConfig
  ): Promise<void> {
    const provider = this.get(name);
    if (!provider) {
      throw new Error(`Provider ${name} not found`);
    }
    
    await provider.initialize(config);
    this.configuredProviders.set(name, config);
  }
  
  /**
   * Get all configured providers
   */
  getConfiguredProviders(): PaymentProvider[] {
    return Array.from(this.providers.values()).filter(p => 
      this.configuredProviders.has(p.name)
    );
  }
  
  /**
   * Check if provider is configured
   */
  isConfigured(name: string): boolean {
    return this.configuredProviders.has(name);
  }
  
  /**
   * List all available providers
   */
  listAvailable(): PaymentProvider[] {
    return Array.from(this.providers.values());
  }
}
```

## Provider Factory

```typescript

export class PaymentProviderFactory {
  constructor(private registry: PaymentProviderRegistry) {}
  
  /**
   * Create provider instance from config
   */
  createProvider(
    name: string,
    config: PaymentProviderConfig
  ): PaymentProvider {
    const ProviderClass = this.getProviderClass(name);
    const provider = new ProviderClass();
    return provider;
  }
  
  /**
   * Get provider class by name
   */
  private getProviderClass(name: string): new () => PaymentProvider {
    switch (name) {
      case 'stripe':
        return StripeAdapter;
      case 'dodo':
        return DodoAdapter;
      case 'polar':
        return PolarAdapter;
      case 'paypal':
        return PayPalAdapter;
      case 'razorpay':
        return RazorpayAdapter;
      default:
        throw new Error(`Unknown provider: ${name}`);
    }
  }
}
```

## Provider Selection Strategy

```typescript

export interface ProviderSelectionStrategy {
  /**
   * Select provider for an operation
   */
  selectProvider(
    context: {
      principalId?: string;
      tenantId?: string;
      operation: string;
      amount?: number;
      currency?: string;
    },
    availableProviders: PaymentProvider[]
  ): Promise<PaymentProvider>;
}

/**
 * Default strategy: Use tenant's preferred provider or first available
 */
export class DefaultProviderSelectionStrategy
  implements ProviderSelectionStrategy
{
  constructor(private db: Adapter) {}
  
  async selectProvider(
    context: {
      principalId?: string;
      tenantId?: string;
      operation: string;
    },
    availableProviders: PaymentProvider[]
  ): Promise<PaymentProvider> {
    // Check if tenant has preferred provider
    if (context.tenantId) {
      const tenant = await this.db.findOne({
        model: 'tenants',
        where: [{ field: 'id', operator: 'eq', value: context.tenantId }],
      });
      
      if (tenant?.preferredPaymentProvider) {
        const provider = availableProviders.find(
          p => p.name === tenant.preferredPaymentProvider
        );
        if (provider) return provider;
      }
    }
    
    // Fallback to first available provider
    return availableProviders[0];
  }
}

/**
 * Round-robin strategy for load balancing
 */
export class RoundRobinProviderSelectionStrategy
  implements ProviderSelectionStrategy
{
  private index = 0;
  
  async selectProvider(
    context: any,
    availableProviders: PaymentProvider[]
  ): Promise<PaymentProvider> {
    const provider = availableProviders[this.index % availableProviders.length];
    this.index++;
    return provider;
  }
}

/**
 * Geographic strategy: Select provider based on customer location
 */
export class GeographicProviderSelectionStrategy
  implements ProviderSelectionStrategy
{
  async selectProvider(
    context: {
      currency?: string;
      country?: string;
    },
    availableProviders: PaymentProvider[]
  ): Promise<PaymentProvider> {
    // Select provider based on currency/country
    // e.g., Razorpay for India, Stripe for US/EU
    if (context.country === 'IN') {
      const razorpay = availableProviders.find(p => p.name === 'razorpay');
      if (razorpay) return razorpay;
    }
    
    // Default to Stripe for international
    const stripe = availableProviders.find(p => p.name === 'stripe');
    return stripe || availableProviders[0];
  }
}
```

## Provider Implementation Example: Stripe

```typescript

import Stripe from 'stripe';
import type {
  PaymentProvider,
  SubscriptionProvider,
  CreateSubscriptionInput,
  Subscription,
} from '../types.js';

export class StripeAdapter
  implements PaymentProvider, SubscriptionProvider
{
  readonly name = 'stripe';
  readonly displayName = 'Stripe';
  readonly version = '1.0.0';
  readonly capabilities = {
    subscriptions: true,
    oneTimePayments: true,
    refunds: true,
    webhooks: true,
    customerPortal: true,
    meteredBilling: true,
  };
  
  private client?: Stripe;
  private config?: StripeConfig;
  
  async initialize(config: PaymentProviderConfig): Promise<void> {
    this.config = config as StripeConfig;
    this.client = new Stripe(config.apiKey, {
      apiVersion: '2024-11-20.acacia',
    });
  }
  
  isConfigured(): boolean {
    return !!this.client;
  }
  
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await this.client!.balance.retrieve();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, message: error.message };
    }
  }
  
  async createSubscription(
    input: CreateSubscriptionInput
  ): Promise<Subscription> {
    if (!this.client) throw new Error('Stripe not initialized');
    
    // Create or get customer
    let customerId = input.customerId;
    if (!customerId) {
      const customer = await this.client.customers.create({
        email: input.email,
        metadata: input.metadata,
      });
      customerId = customer.id;
    }
    
    // Create subscription
    const subscription = await this.client.subscriptions.create({
      customer: customerId,
      items: [{ price: input.planId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { payment_method_types: ['card'] },
      expand: ['latest_invoice.payment_intent'],
    });
    
    // Normalize to common format
    return this.normalizeSubscription(subscription);
  }
  
  async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    if (!this.client) throw new Error('Stripe not initialized');
    
    try {
      const subscription = await this.client.subscriptions.retrieve(
        subscriptionId
      );
      return this.normalizeSubscription(subscription);
    } catch (error) {
      if (error.code === 'resource_missing') return null;
      throw error;
    }
  }
  
  async cancelSubscription(
    subscriptionId: string,
    options?: CancelSubscriptionOptions
  ): Promise<Subscription> {
    if (!this.client) throw new Error('Stripe not initialized');
    
    const subscription = await this.client.subscriptions.update(
      subscriptionId,
      {
        cancel_at_period_end: options?.atPeriodEnd ?? true,
      }
    );
    
    return this.normalizeSubscription(subscription);
  }
  
  /**
   * Normalize Stripe subscription to common format
   */
  private normalizeSubscription(
    stripeSub: Stripe.Subscription
  ): Subscription {
    return {
      id: stripeSub.id,
      provider: 'stripe',
      customerId: stripeSub.customer as string,
      planId: stripeSub.items.data[0]?.price.id || '',
      status: this.normalizeStatus(stripeSub.status),
      currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
      currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      canceledAt: stripeSub.canceled_at
        ? new Date(stripeSub.canceled_at * 1000)
        : undefined,
      trialStart: stripeSub.trial_start
        ? new Date(stripeSub.trial_start * 1000)
        : undefined,
      trialEnd: stripeSub.trial_end
        ? new Date(stripeSub.trial_end * 1000)
        : undefined,
      metadata: stripeSub.metadata,
      providerData: stripeSub, // Store full provider data
    };
  }
  
  private normalizeStatus(
    stripeStatus: Stripe.Subscription.Status
  ): Subscription['status'] {
    const statusMap: Record<string, Subscription['status']> = {
      active: 'active',
      trialing: 'trialing',
      past_due: 'past_due',
      canceled: 'canceled',
      unpaid: 'unpaid',
      incomplete: 'incomplete',
      incomplete_expired: 'canceled',
    };
    return statusMap[stripeStatus] || 'canceled';
  }
}
```

## Provider Implementation Example: Dodo Payments

```typescript

import type {
  PaymentProvider,
  SubscriptionProvider,
  CreateSubscriptionInput,
  Subscription,
} from '../types.js';

export class DodoAdapter
  implements PaymentProvider, SubscriptionProvider
{
  readonly name = 'dodo';
  readonly displayName = 'Dodo Payments';
  readonly version = '1.0.0';
  readonly capabilities = {
    subscriptions: true,
    oneTimePayments: true,
    refunds: true,
    webhooks: true,
    customerPortal: false, // Dodo may not support this
    meteredBilling: false,
  };
  
  private client?: DodoClient;
  private config?: DodoConfig;
  
  async initialize(config: PaymentProviderConfig): Promise<void> {
    this.config = config as DodoConfig;
    this.client = new DodoClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.dodopayments.com',
    });
  }
  
  isConfigured(): boolean {
    return !!this.client;
  }
  
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      await this.client!.ping();
      return { healthy: true };
    } catch (error) {
      return { healthy: false, message: error.message };
    }
  }
  
  async createSubscription(
    input: CreateSubscriptionInput
  ): Promise<Subscription> {
    if (!this.client) throw new Error('Dodo not initialized');
    
    // Dodo-specific API call
    const response = await this.client.post('/subscriptions', {
      customer_email: input.email,
      plan_id: input.planId,
      metadata: input.metadata,
    });
    
    // Normalize to common format
    return this.normalizeSubscription(response.data);
  }
  
  async getSubscription(subscriptionId: string): Promise<Subscription | null> {
    if (!this.client) throw new Error('Dodo not initialized');
    
    try {
      const response = await this.client.get(`/subscriptions/${subscriptionId}`);
      return this.normalizeSubscription(response.data);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }
  
  /**
   * Normalize Dodo subscription to common format
   */
  private normalizeSubscription(dodoSub: DodoSubscription): Subscription {
    return {
      id: dodoSub.id,
      provider: 'dodo',
      customerId: dodoSub.customer_id,
      planId: dodoSub.plan_id,
      status: this.normalizeStatus(dodoSub.status),
      currentPeriodStart: new Date(dodoSub.current_period_start),
      currentPeriodEnd: new Date(dodoSub.current_period_end),
      cancelAtPeriodEnd: dodoSub.cancel_at_period_end,
      canceledAt: dodoSub.canceled_at
        ? new Date(dodoSub.canceled_at)
        : undefined,
      metadata: dodoSub.metadata,
      providerData: dodoSub,
    };
  }
  
  private normalizeStatus(dodoStatus: string): Subscription['status'] {
    const statusMap: Record<string, Subscription['status']> = {
      active: 'active',
      trial: 'trialing',
      past_due: 'past_due',
      cancelled: 'canceled',
      unpaid: 'unpaid',
    };
    return statusMap[dodoStatus] || 'canceled';
  }
}
```

## BillFn Core Integration

```typescript

export interface BillFnConfig {
  db: Adapter;
  namespace?: string;
  paymentProviders?: {
    stripe?: { apiKey: string; webhookSecret?: string };
    dodo?: { apiKey: string; baseUrl?: string; webhookSecret?: string };
    polar?: { apiKey: string; webhookSecret?: string };
    paypal?: { clientId: string; clientSecret: string };
    razorpay?: { keyId: string; keySecret: string };
  };
  providerSelectionStrategy?: ProviderSelectionStrategy;
}

export function createBillFn(config: BillFnConfig): BillFn {
  const registry = new PaymentProviderRegistry();
  const factory = new PaymentProviderFactory(registry);
  
  // Register built-in providers
  registry.register(new StripeAdapter());
  registry.register(new DodoAdapter());
  registry.register(new PolarAdapter());
  // ... other providers
  
  // Configure enabled providers
  if (config.paymentProviders) {
    for (const [name, providerConfig] of Object.entries(
      config.paymentProviders
    )) {
      const provider = factory.createProvider(name, providerConfig);
      await registry.configure(name, providerConfig);
    }
  }
  
  // Create provider manager
  const providerManager = new PaymentProviderManager(
    registry,
    config.providerSelectionStrategy ||
      new DefaultProviderSelectionStrategy(config.db)
  );
  
  // Create subscription service that uses provider manager
  const subscriptionService = new SubscriptionService(
    config.db,
    providerManager
  );
  
  return {
    subscriptions: subscriptionService,
    // ... other services
  };
}
```

## Usage Example

```typescript
// Example: Using BillFn with multiple providers

import { createBillFn } from '@billfn/server';

const billFn = createBillFn({
  db: postgresAdapter,
  paymentProviders: {
    stripe: {
      apiKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    },
    dodo: {
      apiKey: process.env.DODO_API_KEY,
      baseUrl: process.env.DODO_BASE_URL,
      webhookSecret: process.env.DODO_WEBHOOK_SECRET,
    },
    polar: {
      apiKey: process.env.POLAR_API_KEY,
      webhookSecret: process.env.POLAR_WEBHOOK_SECRET,
    },
  },
  // Optional: Custom provider selection strategy
  providerSelectionStrategy: new GeographicProviderSelectionStrategy(),
});

// Create subscription - automatically selects provider
const subscription = await billFn.subscriptions.create({
  customerId: 'customer_123',
  planId: 'plan_pro',
  email: 'user@example.com',
  // Provider selection happens automatically based on strategy
});

// Get subscription - works with any provider
const sub = await billFn.subscriptions.get(subscription.id);

// Cancel subscription
await billFn.subscriptions.cancel(subscription.id, {
  atPeriodEnd: true,
});
```

## Webhook Handling

```typescript

export class WebhookHandler {
  constructor(private registry: PaymentProviderRegistry) {}
  
  async handleWebhook(
    provider: string,
    payload: string | Buffer,
    signature: string
  ): Promise<WebhookEvent> {
    const providerAdapter = this.registry.get(provider);
    if (!providerAdapter) {
      throw new Error(`Provider ${provider} not found`);
    }
    
    if (!('verifyWebhook' in providerAdapter)) {
      throw new Error(`Provider ${provider} does not support webhooks`);
    }
    
    // Verify signature
    const config = this.registry.getConfig(provider);
    const isValid = providerAdapter.verifyWebhook(
      payload,
      signature,
      config.webhookSecret
    );
    
    if (!isValid) {
      throw new Error('Invalid webhook signature');
    }
    
    // Parse event
    const event = providerAdapter.parseWebhookEvent(
      JSON.parse(payload.toString())
    );
    
    // Normalize event
    return this.normalizeEvent(event, provider);
  }
  
  private normalizeEvent(
    event: any,
    provider: string
  ): WebhookEvent {
    // Normalize provider-specific events to common format
    return {
      id: event.id,
      provider,
      type: this.normalizeEventType(event.type, provider),
      data: event.data,
      createdAt: new Date(event.created || Date.now()),
    };
  }
}
```

## Error Handling

```typescript

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public code: string,
    public statusCode?: number
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

export function normalizeProviderError(
  error: any,
  provider: string
): PaymentProviderError {
  // Normalize provider-specific errors to common format
  if (provider === 'stripe') {
    return new PaymentProviderError(
      error.message,
      'stripe',
      error.code || 'unknown',
      error.statusCode
    );
  }
  
  if (provider === 'dodo') {
    return new PaymentProviderError(
      error.message || 'Dodo payment error',
      'dodo',
      error.error_code || 'unknown',
      error.status
    );
  }
  
  // Generic fallback
  return new PaymentProviderError(
    error.message || 'Payment provider error',
    provider,
    'unknown'
  );
}
```

## Database Schema

```typescript
// Store provider configuration per tenant
interface TenantPaymentProvider {
  tenantId: string;
  provider: string; // 'stripe', 'dodo', etc.
  isActive: boolean;
  isDefault: boolean;
  config: Record<string, any>; // Encrypted provider-specific config
  createdAt: Date;
}

// Store subscriptions with provider info
interface SubscriptionRecord {
  id: string;
  provider: string; // Which provider this subscription uses
  providerSubscriptionId: string; // Provider's subscription ID
  customerId: string;
  planId: string;
  status: string;
  // ... other fields
}
```

## Implementation Checklist

### Core Infrastructure

- [ ] Define provider interfaces (`PaymentProvider`, `SubscriptionProvider`, etc.)
- [ ] Create provider registry
- [ ] Create provider factory
- [ ] Implement provider selection strategies
- [ ] Create normalized data models
- [ ] Implement error normalization

### Provider Implementations

- [ ] Stripe adapter
- [ ] Dodo Payments adapter
- [ ] Polar adapter
- [ ] PayPal adapter (optional)
- [ ] Razorpay adapter (optional)

### Features

- [ ] Webhook handling and verification
- [ ] Provider health checks
- [ ] Multi-provider support per tenant
- [ ] Provider failover logic
- [ ] Configuration management
- [ ] Secret encryption for provider credentials

### Testing

- [ ] Unit tests for each provider adapter
- [ ] Integration tests with real providers (sandbox/test mode)
- [ ] Webhook handling tests
- [ ] Provider selection strategy tests
- [ ] Error handling tests

## Benefits

1. **Flexibility**: Users can choose their preferred payment provider
2. **Multi-Provider Support**: Support multiple providers simultaneously
3. **Vendor Lock-in Prevention**: Easy to switch providers
4. **Extensibility**: Simple to add new providers
5. **Unified API**: Single API works across all providers
6. **Geographic Support**: Use region-appropriate providers
7. **Failover**: Automatic failover if one provider fails

## Future Enhancements

- Provider performance monitoring
- Automatic provider failover
- A/B testing different providers
- Cost optimization (select cheapest provider)
- Multi-currency support with provider selection
- Provider-specific feature detection
- Custom provider plugins (allow users to add their own)
