# BillFn Plugin Integration Approach

## Overview

BillFn should be designed to integrate seamlessly with other super functions as a plugin/provider, enabling them to delegate billing, subscription, and quota checks. This document outlines the approach and provides sample code.

## Core Design Principles

1. **Provider Interface Pattern**: BillFn exposes provider interfaces that other super functions can accept in their config
2. **Optional Integration**: All integrations are optional - super functions work without billfn, but can enhance functionality with it
3. **Unified API**: BillFn provides consistent interfaces for subscription checks, quota management, and usage tracking
4. **Multi-tenant Support**: All interfaces support principalId and tenantId for multi-tenant scenarios

## BillFn Provider Interfaces

### 1. Subscription Provider

For checking subscription status and plan information:

```typescript
// billfn/typescript/src/types/providers.ts

export interface SubscriptionProvider {
  /**
   * Check if a subscription is active and meets requirements
   */
  checkSubscription(input: {
    principalId?: string;
    tenantId?: string;
    requiredPlan?: string;
    requiredFeatures?: string[];
  }): Promise<{
    active: boolean;
    plan?: string;
    features?: string[];
    expiresAt?: Date;
    reason?: string; // e.g., "expired", "insufficient_plan", "payment_failed"
  }>;

  /**
   * Get subscription details
   */
  getSubscription(input: {
    principalId?: string;
    tenantId?: string;
  }): Promise<{
    plan: string;
    status: 'active' | 'trial' | 'expired' | 'cancelled' | 'past_due';
    features: string[];
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null>;
}
```

### 2. Quota Provider

For checking and tracking resource quotas:

```typescript
// billfn/typescript/src/types/providers.ts

export interface QuotaProvider {
  /**
   * Check if an operation is allowed within quota limits
   */
  checkQuota(input: {
    principalId?: string;
    tenantId?: string;
    resourceType: string; // e.g., "storage", "api_calls", "users"
    requestedAmount: number;
    unit?: string; // e.g., "bytes", "count"
  }): Promise<{
    allowed: boolean;
    current: number;
    limit: number;
    warning?: string;
    resetAt?: Date;
  }>;

  /**
   * Record usage after an operation
   */
  recordUsage(input: {
    principalId?: string;
    tenantId?: string;
    resourceType: string;
    amount: number;
    unit?: string;
    metadata?: Record<string, any>;
  }): Promise<void>;

  /**
   * Get current usage for a resource type
   */
  getUsage(input: {
    principalId?: string;
    tenantId?: string;
    resourceType: string;
    period?: 'current' | 'month' | 'year';
  }): Promise<{
    current: number;
    limit: number;
    periodStart: Date;
    periodEnd: Date;
  }>;
}
```

### 3. Feature Access Provider

For checking feature flags and entitlements:

```typescript
// billfn/typescript/src/types/providers.ts

export interface FeatureAccessProvider {
  /**
   * Check if a feature is available
   */
  hasFeature(input: {
    principalId?: string;
    tenantId?: string;
    feature: string;
  }): Promise<boolean>;

  /**
   * Get all available features
   */
  getFeatures(input: {
    principalId?: string;
    tenantId?: string;
  }): Promise<string[]>;
}
```

## BillFn Implementation

### Core BillFn Instance

```typescript
// billfn/typescript/src/core/billfn.ts

import type { Adapter } from '@superfunctions/db';
import type { SubscriptionProvider, QuotaProvider, FeatureAccessProvider } from '../types/providers.js';

export interface BillFnConfig {
  db: Adapter;
  namespace?: string;
  // Payment provider integrations
  paymentProviders?: {
    stripe?: { apiKey: string };
    polar?: { apiKey: string };
    // ... other providers
  };
}

export interface BillFn {
  // Provider implementations
  asSubscriptionProvider(): SubscriptionProvider;
  asQuotaProvider(): QuotaProvider;
  asFeatureAccessProvider(): FeatureAccessProvider;
  
  // Direct API methods
  subscriptions: SubscriptionAPI;
  quotas: QuotaAPI;
  features: FeatureAPI;
  usage: UsageAPI;
}

export function createBillFn(config: BillFnConfig): BillFn {
  // Implementation creates providers that can be used by other super functions
  const subscriptionProvider = createSubscriptionProvider(config);
  const quotaProvider = createQuotaProvider(config);
  const featureProvider = createFeatureAccessProvider(config);

  return {
    asSubscriptionProvider: () => subscriptionProvider,
    asQuotaProvider: () => quotaProvider,
    asFeatureAccessProvider: () => featureProvider,
    // ... other APIs
  };
}
```

## Integration Examples

### Example 1: FileFn Integration

FileFn can accept BillFn as a quota provider:

```typescript
// Example: Using BillFn with FileFn

import { createFileFn } from '@filefn/server';
import { createBillFn } from '@billfn/core';
import { createPostgresAdapter } from '@superfunctions/db';

// Initialize BillFn
const billFn = createBillFn({
  db: postgresAdapter,
  paymentProviders: {
    stripe: { apiKey: process.env.STRIPE_API_KEY },
  },
});

// Use BillFn's quota provider with FileFn
const fileFn = createFileFn({
  db: postgresAdapter,
  storage: s3Storage,
  // BillFn provides the QuotaProvider interface
  quota: billFn.asQuotaProvider(),
  policies: [
    {
      name: 'user-avatar',
      contentTypes: ['image/png', 'image/jpeg'],
      maxSizeBytes: 5 * 1024 * 1024, // 5MB
    },
  ],
});

// Now FileFn will automatically check storage quotas before uploads
// The quota check happens in createUploadSession:
// - Checks if user has enough storage quota
// - Throws quotaExceeded error if limit reached
// - Records usage after successful upload
```

**How it works internally in FileFn:**

```typescript
// filefn/server/src/upload-sessions/service.ts (existing code)

async createSession(input, ctx) {
  // ... validation ...

  // Check quota (BillFn's QuotaProvider is called here)
  if (quota) {
    const quotaResult = await quota.checkQuota({
      principalId: ctx.principalId,
      tenantId: ctx.tenantId,
      resourceType: 'storage',
      requestedAmount: input.size,
      unit: 'bytes',
    });

    if (!quotaResult.allowed) {
      throw errors.quotaExceeded(
        quotaResult.current,
        quotaResult.limit,
        input.size
      );
    }
  }

  // ... create upload session ...

  // After successful upload, record usage
  if (quota) {
    await quota.recordUsage({
      principalId: ctx.principalId,
      tenantId: ctx.tenantId,
      resourceType: 'storage',
      amount: input.size,
      unit: 'bytes',
    });
  }
}
```

### Example 2: AuthFn Integration

AuthFn can check subscription status before allowing certain operations:

```typescript
// Example: Using BillFn with AuthFn

import { createAuthFn } from '@authfn/core';
import { createBillFn } from '@billfn/core';

const billFn = createBillFn({
  db: postgresAdapter,
  paymentProviders: {
    stripe: { apiKey: process.env.STRIPE_API_KEY },
  },
});

const authFn = createAuthFn({
  db: postgresAdapter,
  // AuthFn can accept subscription provider
  subscriptionProvider: billFn.asSubscriptionProvider(),
});

// Custom authorization logic using subscription checks
async function authorizeWithSubscription(
  session: Session,
  action: string,
  resourceId: string
): Promise<boolean> {
  // Check if subscription is required for this action
  if (requiresSubscription(action)) {
    const subscription = await billFn
      .asSubscriptionProvider()
      .checkSubscription({
        principalId: session.principalId,
        tenantId: session.tenantId,
        requiredPlan: 'pro', // or 'enterprise'
        requiredFeatures: ['advanced_auth'],
      });

    if (!subscription.active) {
      throw new Error(
        `Subscription required: ${subscription.reason || 'inactive'}`
      );
    }
  }

  return true;
}
```

### Example 3: DataFn Integration

DataFn can use BillFn for rate limiting and quota management:

```typescript
// Example: Using BillFn with DataFn

import { createDatafnServer } from '@datafn/server';
import { createBillFn } from '@billfn/core';

const billFn = createBillFn({
  db: postgresAdapter,
});

const datafnServer = createDatafnServer({
  schema: mySchema,
  db: postgresAdapter,
  authorize: async (ctx, action, payload) => {
    // Check subscription for mutations
    if (action === 'mutation' || action === 'transact') {
      const subscription = await billFn
        .asSubscriptionProvider()
        .checkSubscription({
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
        });

      if (!subscription.active) {
        return false;
      }
    }

    // Check quota for queries (API call limits)
    if (action === 'query') {
      const quota = await billFn.asQuotaProvider().checkQuota({
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
        resourceType: 'api_calls',
        requestedAmount: 1,
        unit: 'count',
      });

      if (!quota.allowed) {
        return false;
      }

      // Record usage after successful query
      await billFn.asQuotaProvider().recordUsage({
        principalId: ctx.principalId,
        tenantId: ctx.tenantId,
        resourceType: 'api_calls',
        amount: 1,
        unit: 'count',
      });
    }

    return true;
  },
});
```

## Alternative: Plugin Pattern

For super functions that support plugins (like DataFn), BillFn can be a plugin:

```typescript
// billfn/typescript/src/plugins/datafn-plugin.ts

import type { DatafnPlugin } from '@datafn/core';
import type { BillFn } from '../core/billfn.js';

export function createBillFnPlugin(billFn: BillFn): DatafnPlugin {
  return {
    name: 'billfn',
    hooks: {
      beforeQuery: async (ctx, query) => {
        // Check quota
        const quota = await billFn.asQuotaProvider().checkQuota({
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
          resourceType: 'datafn_queries',
          requestedAmount: 1,
        });

        if (!quota.allowed) {
          throw new Error('Query quota exceeded');
        }
      },
      afterQuery: async (ctx, query, result) => {
        // Record usage
        await billFn.asQuotaProvider().recordUsage({
          principalId: ctx.principalId,
          tenantId: ctx.tenantId,
          resourceType: 'datafn_queries',
          amount: 1,
        });
      },
      beforeMutation: async (ctx, mutation) => {
        // Check subscription
        const subscription = await billFn
          .asSubscriptionProvider()
          .checkSubscription({
            principalId: ctx.principalId,
            tenantId: ctx.tenantId,
            requiredPlan: 'pro',
          });

        if (!subscription.active) {
          throw new Error('Subscription required for mutations');
        }
      },
    },
  };
}

// Usage:
const billFn = createBillFn({ db, ... });
const datafnServer = createDatafnServer({
  schema: mySchema,
  db,
  plugins: [createBillFnPlugin(billFn)],
});
```

## Configuration Pattern

Super functions can accept BillFn in multiple ways:

### Option 1: Direct Provider (Recommended)

```typescript
// Super function accepts provider interface directly
interface SuperFnConfig {
  // ... other config
  quotaProvider?: QuotaProvider;
  subscriptionProvider?: SubscriptionProvider;
}

// Usage
const billFn = createBillFn({ db, ... });
const superFn = createSuperFn({
  // ... other config
  quotaProvider: billFn.asQuotaProvider(),
  subscriptionProvider: billFn.asSubscriptionProvider(),
});
```

### Option 2: BillFn Instance

```typescript
// Super function accepts BillFn instance
interface SuperFnConfig {
  // ... other config
  billFn?: BillFn;
}

// Usage
const billFn = createBillFn({ db, ... });
const superFn = createSuperFn({
  // ... other config
  billFn: billFn,
});

// Internally, super function extracts providers:
// const quotaProvider = config.billFn?.asQuotaProvider();
```

### Option 3: Plugin Array

```typescript
// For functions that support plugins
interface SuperFnConfig {
  // ... other config
  plugins?: Plugin[];
}

// Usage
const billFn = createBillFn({ db, ... });
const superFn = createSuperFn({
  // ... other config
  plugins: [billFn.asPlugin()],
});
```

## Implementation Checklist

### BillFn Core

- [ ] Define provider interfaces (`SubscriptionProvider`, `QuotaProvider`, `FeatureAccessProvider`)
- [ ] Implement provider adapters that wrap BillFn's internal APIs
- [ ] Create `asSubscriptionProvider()`, `asQuotaProvider()`, `asFeatureAccessProvider()` methods
- [ ] Support multi-tenant scenarios (principalId, tenantId)
- [ ] Handle errors gracefully (subscription expired, quota exceeded, etc.)

### Integration Points

- [ ] FileFn: Implement `QuotaProvider` interface for storage quotas
- [ ] AuthFn: Add optional `SubscriptionProvider` in config
- [ ] DataFn: Create plugin or add provider support
- [ ] Other super functions: Add provider support as needed

### Testing

- [ ] Unit tests for provider interfaces
- [ ] Integration tests with FileFn
- [ ] Integration tests with AuthFn
- [ ] Integration tests with DataFn
- [ ] Test error handling (expired subscriptions, exceeded quotas)

## Benefits

1. **Separation of Concerns**: Billing logic is centralized in BillFn
2. **Reusability**: One BillFn instance can serve multiple super functions
3. **Flexibility**: Super functions can work with or without BillFn
4. **Consistency**: All super functions use the same billing/subscription APIs
5. **Testability**: Provider interfaces can be easily mocked in tests

## Future Enhancements

- Webhook support for subscription events (renewal, cancellation, etc.)
- Usage analytics and reporting
- Automatic quota enforcement middleware
- Multi-currency support
- Usage-based pricing calculations
- Trial period management
