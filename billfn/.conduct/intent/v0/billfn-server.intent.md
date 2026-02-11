- Billfn server provides core capabilities for managing payments, subscriptions etc
- Store payments to manage payments, subscriptions etc on App store and Play store.


# General requirements
- Should use `@superfunctions/http` for exposing API endpoints like other super functions. This will be used by the client app to interact with the billfn server. Or in cases when billfn is separately hosted from main backend.
- Should use `@superfunctions/db` for storing data like other super functions.


# Metering, quota management, feature access
- Metering, quota management, feature access are core capabilities of billfn


# Provider interfaces
- Subscription provider
- Quota provider
- Feature access provider

# Payment providers
Refer to `ai-notes/multi-payment-provider-approach.md` for more details.
- Provider interface pattern, adaptors
- Multi provider support
- Webhook handling and verification


# Store payments


# Usage across other super functions

1. **Provider Interface Pattern**: BillFn exposes provider interfaces that other super functions can accept in their config
2. **Optional Integration**: All integrations are optional - super functions work without billfn, but can enhance functionality with it
3. **Unified API**: BillFn provides consistent interfaces for subscription checks, quota management, and usage tracking
4. **Multi-tenant Support**: All interfaces support principalId and tenantId for multi-tenant scenarios

## BillFn Provider Interfaces

### 1. Subscription Provider

For checking subscription status and plan information:

```typescript

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
import { createBillFn } from '@billfn/server';
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


# Scope for v0
- All core logic
- Adaptors
  - Dodo payments
  - Stripe