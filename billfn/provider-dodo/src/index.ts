import type {
  BillFnCancelSubscriptionInput,
  BillFnChangeSubscriptionInput,
  BillFnCreateCheckoutInput,
  BillFnImportSubscriptionInput,
  BillFnParseWebhookInput,
  BillFnParsedWebhookEvent,
  BillFnProviderAdapter,
  BillFnProviderOperationResult,
  BillFnRefundChargeInput,
  BillFnRestorePurchasesInput,
  BillFnResumeSubscriptionInput,
  BillFnSyncSubscriptionInput,
  BillFnVerifiedBillingState,
  BillFnVerifyCheckoutInput
} from '@billfn/core';
import { createBillFnError } from '@billfn/core';
import { verifyStandardWebhookSignature } from '@superfunctions/webhooks';

/** Dodo's API modes. Test mode is the default; live mode needs explicit configuration. */
export type DodoEnvironment = 'test_mode' | 'live_mode';

/** The API host of each Dodo mode, as Dodo's API reference lists them. */
export const DODO_BASE_URLS: Readonly<Record<DodoEnvironment, string>> = {
  test_mode: 'https://test.dodopayments.com',
  live_mode: 'https://live.dodopayments.com'
};

export interface DodoProviderConfig {
  apiKey: string;
  /**
   * The Dodo mode the adapter calls: `test_mode` (the default) or `live_mode`.
   * A test mode key works only in test mode and a live mode key only in live mode.
   */
  environment?: DodoEnvironment;
  /** Overrides the mode's host, for example for a proxy or a recorded-fixture server. */
  baseUrl?: string;
  fetch?: typeof fetch;
  webhookSecret?: string;
  webhookSignatureHeader?: string;
}

const DODO_CHECKOUT_SESSION_METADATA_KEY = 'billfn_checkout_session_id';
const DODO_BILLING_ACCOUNT_METADATA_KEY = 'billfn_billing_account_id';
const DODO_PRODUCT_METADATA_KEY = 'billfn_product_id';
const DODO_PRICE_METADATA_KEY = 'billfn_price_id';

export function createDodoProvider(config: DodoProviderConfig): BillFnProviderAdapter {
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = resolveDodoBaseUrl(config);
  const webhookSignatureHeader = (config.webhookSignatureHeader ?? 'webhook-signature').toLowerCase();
  const get = (...segments: string[]) =>
    requestJson(fetchImpl, dodoUrl(baseUrl, segments), { method: 'GET', headers: createHeaders(config.apiKey) });
  const patchSubscription = (providerSubscriptionId: string, body: Record<string, unknown>) =>
    requestJson(fetchImpl, dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]), {
      method: 'PATCH',
      headers: createHeaders(config.apiKey),
      body: JSON.stringify(body)
    });

  return {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: true,
      syncSubscription: true,
      restorePurchases: true,
      webhookIngestion: true,
      changeSubscription: true,
      resumeSubscription: true,
      refundCharge: true,
      importSubscription: true
    },
    async createCheckout(input: BillFnCreateCheckoutInput) {
      // Dodo's checkout sessions replace the deprecated payment-link creation of POST /payments and /subscriptions.
      const response = await requestJson(fetchImpl, dodoUrl(baseUrl, ['checkouts']), {
        method: 'POST',
        headers: createHeaders(config.apiKey),
        body: JSON.stringify(createDodoCheckoutSessionBody(input))
      });
      const sessionId = readString(response, ['session_id']);
      if (!sessionId) {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: 'Dodo returned a checkout session without its id'
        });
      }

      return {
        status: 'requires_action',
        providerCheckoutId: sessionId,
        providerChargeId: readString(response, ['payment_id']),
        checkoutUrl: readString(response, ['checkout_url']),
        raw: response
      };
    },
    async verifyCheckout(input: BillFnVerifyCheckoutInput): Promise<BillFnVerifiedBillingState> {
      const isSubscription = input.price.kind === 'subscription';
      let subscriptionId =
        input.checkoutSession.providerSubscriptionId ??
        readString(input.payload ?? {}, ['subscriptionId', 'subscription_id']);
      let chargeId =
        input.checkoutSession.providerChargeId ?? readString(input.payload ?? {}, ['paymentId', 'payment_id']);
      let sessionCheckoutId: string | undefined;
      // A charge BillFn links to the subscription must be server-recorded or read from Dodo, never only client-sent.
      let chargeVerified = Boolean(input.checkoutSession.providerChargeId);

      if (!chargeId && (!isSubscription || !subscriptionId)) {
        const providerCheckoutId = input.checkoutSession.providerCheckoutId;
        if (!providerCheckoutId) {
          throw createBillFnError({
            code: 'BILLFN_VALIDATION_ERROR',
            message: 'Dodo verification requires a checkout session, subscription or payment identifier'
          });
        }
        const session = await get('checkouts', providerCheckoutId);
        if (readString(session, ['id']) !== providerCheckoutId) {
          throw createBillFnError({
            code: 'BILLFN_CONFLICT',
            message: 'Dodo returned a different checkout session than the one BillFn created'
          });
        }
        chargeId = readString(session, ['payment_id']);
        if (!chargeId) {
          throw createBillFnError({
            code: 'BILLFN_CONFLICT',
            message: 'The Dodo checkout session has no payment yet; verify again after the customer pays',
            details: { checkoutStatus: 'pending' }
          });
        }
        sessionCheckoutId = providerCheckoutId;
        chargeVerified = true;
      }

      if (isSubscription && !subscriptionId && chargeId) {
        const payment = await get('payments', chargeId);
        assertDodoPaymentOwnership(input, chargeId, sessionCheckoutId, payment);
        chargeVerified = true;
        subscriptionId = readDodoPaymentSubscriptionId(payment);
        if (!subscriptionId) {
          if (normalizeDodoPaymentStatus(readString(payment, ['status'])) === 'failed') {
            return { ...mapDodoPaymentState(payment), providerChargeId: chargeId };
          }
          throw createBillFnError({
            code: 'BILLFN_CONFLICT',
            message: 'The Dodo payment has not started its subscription yet; verify again later',
            details: { checkoutStatus: 'pending' }
          });
        }
      }

      const resourceId = isSubscription ? subscriptionId : chargeId;
      if (!resourceId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo verification requires a subscription or payment identifier'
        });
      }

      const response = await get(isSubscription ? 'subscriptions' : 'payments', resourceId);
      assertDodoVerificationOwnership(input, isSubscription, resourceId, response);
      if (!isSubscription && sessionCheckoutId) {
        assertDodoPaymentSession(sessionCheckoutId, response);
      }

      if (!isSubscription) {
        return mapDodoPaymentState(response);
      }
      // A Dodo subscription does not name its payment; the payment that started it is BillFn's refundable charge.
      const state = mapDodoSubscriptionState(response);
      return chargeVerified && chargeId ? { ...state, providerChargeId: chargeId } : state;
    },
    async fetchSubscription(input: BillFnSyncSubscriptionInput) {
      const providerSubscriptionId = input.subscription.providerSubscriptionId;
      if (!providerSubscriptionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo subscription sync requires providerSubscriptionId'
        });
      }
      return mapDodoSubscriptionState(await get('subscriptions', providerSubscriptionId));
    },
    async cancelSubscription(input: BillFnCancelSubscriptionInput) {
      const providerSubscriptionId = input.subscription.providerSubscriptionId;
      if (!providerSubscriptionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo cancellation requires providerSubscriptionId'
        });
      }
      const response = await patchSubscription(providerSubscriptionId, { cancel_at_next_billing_date: true });
      return {
        operationStatus: 'applied',
        billingState: mapDodoSubscriptionState(response),
        raw: response
      } satisfies BillFnProviderOperationResult;
    },
    async changeSubscription(input: BillFnChangeSubscriptionInput) {
      const providerSubscriptionId = input.subscription.providerSubscriptionId;
      if (!providerSubscriptionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo change subscription requires providerSubscriptionId'
        });
      }

      const attempted = await tryRequestJson(
        fetchImpl,
        dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId, 'change-plan']),
        {
          method: 'POST',
          headers: createHeaders(config.apiKey),
          body: JSON.stringify({
            product_id: input.targetPrice.providerProductId,
            proration_billing_mode: normalizeDodoProration(input.prorationBehavior),
            quantity: 1,
            effective_at: normalizeDodoEffectiveAt(input.effectiveAt)
          })
        }
      );

      if (attempted.ok) {
        // Change-plan answers with payment handles, not the subscription, so the subscription is read after it.
        const paymentLink = readString(attempted.data, ['payment_link']);
        if (paymentLink) {
          return {
            operationStatus: 'requires_action',
            clientAction: {
              type: 'redirect',
              url: paymentLink,
              metadata: { action: 'plan-change-payment', paymentId: readString(attempted.data, ['payment_id']) }
            },
            raw: attempted.data
          } satisfies BillFnProviderOperationResult;
        }
        const subscription = await tryRequestJson(fetchImpl, dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]), {
          method: 'GET',
          headers: createHeaders(config.apiKey)
        });
        // The change is committed at Dodo; a failed read leaves the state to the next webhook or sync.
        return {
          operationStatus: 'applied',
          billingState: subscription.ok ? mapDodoSubscriptionState(subscription.data) : undefined,
          raw: subscription.ok
            ? { changePlan: attempted.data, subscription: subscription.data }
            : { changePlan: attempted.data, subscriptionReadError: subscription.error }
        } satisfies BillFnProviderOperationResult;
      }

      if (!shouldFallbackToReplacementCheckout(attempted.error.status)) {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: `Dodo change subscription failed with status ${attempted.error.status}`,
          details: attempted.error
        });
      }

      const cancellation = await patchSubscription(providerSubscriptionId, { cancel_at_next_billing_date: true });

      return {
        operationStatus: 'requires_action',
        billingState: input.effectiveAt === 'immediate' ? mapDodoSubscriptionState(cancellation) : undefined,
        clientAction: {
          type: 'redirect',
          metadata: {
            action: 'replacement-checkout',
            targetProductId: input.targetPrice.providerProductId,
            effectiveAt: input.effectiveAt
          }
        },
        raw: {
          fallback: 'replacement-checkout',
          updateError: attempted.error,
          cancellation
        }
      } satisfies BillFnProviderOperationResult;
    },
    async resumeSubscription(input: BillFnResumeSubscriptionInput) {
      const providerSubscriptionId = input.subscription.providerSubscriptionId;
      if (!providerSubscriptionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo resume subscription requires providerSubscriptionId'
        });
      }

      // Dodo resumes a paused subscription with `status: active` sent alone, and a scheduled cancel by clearing it.
      const attempted = await tryRequestJson(fetchImpl, dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]), {
        method: 'PATCH',
        headers: createHeaders(config.apiKey),
        body: JSON.stringify(
          input.subscription.status === 'paused' ? { status: 'active' } : { cancel_at_next_billing_date: false }
        )
      });

      if (!attempted.ok) {
        return {
          operationStatus: 'requires_action',
          clientAction: {
            type: 'redirect',
            metadata: {
              action: 'contact-support'
            }
          },
          raw: {
            resumeError: attempted.error
          }
        } satisfies BillFnProviderOperationResult;
      }

      return {
        operationStatus: 'applied',
        billingState: mapDodoSubscriptionState(attempted.data),
        raw: attempted.data
      } satisfies BillFnProviderOperationResult;
    },
    async refundCharge(input: BillFnRefundChargeInput) {
      const paymentId = input.providerChargeId ?? input.subscription?.providerChargeId;
      if (!paymentId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo refund requires providerChargeId'
        });
      }
      const refundBody: Record<string, unknown> = {
        payment_id: paymentId,
        reason: input.reason
      };
      if ((input.mode === 'custom' || input.mode === 'prorated_remaining_period') && input.amount !== undefined) {
        // Dodo refunds part of a payment only through its line items, each up to its refundable amount.
        Object.assign(refundBody, allocateDodoPartialRefund(input.amount, await get('payments', paymentId, 'line-items')));
      }

      const response = await requestJson(fetchImpl, dodoUrl(baseUrl, ['refunds']), {
        method: 'POST',
        headers: createHeaders(config.apiKey),
        body: JSON.stringify(refundBody)
      });
      if (readString(response, ['status']) === 'failed') {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: 'Dodo reported the refund as failed',
          details: { refundId: readString(response, ['refund_id']), status: 'failed' }
        });
      }

      return {
        operationStatus: 'applied',
        providerRefundId: readString(response, ['refund_id', 'id']),
        raw: response
      } satisfies BillFnProviderOperationResult;
    },
    async restorePurchases(input: BillFnRestorePurchasesInput) {
      const isSubscription = input.price.kind === 'subscription';
      const response = await get(isSubscription ? 'subscriptions' : 'payments', input.purchaseReference);

      assertDodoRestoreOwnership(input, isSubscription, response);

      return [isSubscription ? mapDodoSubscriptionState(response) : mapDodoPaymentState(response)];
    },
    async importSubscription(input: BillFnImportSubscriptionInput) {
      // A subscription created outside BillFn carries no billfn_* metadata, so only its identity is checked.
      let result: Awaited<ReturnType<typeof tryRequestJson>>;
      try {
        result = await tryRequestJson(fetchImpl, dodoUrl(baseUrl, ['subscriptions', input.providerReference]), {
          method: 'GET',
          headers: createHeaders(config.apiKey)
        });
      } catch (error) {
        // No answer from Dodo (the request or its body read failed) or an unreadable one: a retry may read it.
        // The raw error stays out of the message, which reaches the operator.
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message:
            error instanceof SyntaxError
              ? 'Dodo returned an unreadable subscription response'
              : 'Dodo could not be reached to read the imported subscription'
        });
      }
      if (!result.ok) {
        // Dodo has no such subscription: BillFn reports it as not found, which a retry does not change.
        if (result.error.status === 404) {
          return null;
        }
        // Dodo rejects the id itself (the only input of this read): invalid input, which a retry does not change.
        if (result.error.status === 400 || result.error.status === 422) {
          throw createBillFnError({
            code: 'BILLFN_VALIDATION_ERROR',
            message: `Dodo rejected the imported subscription id with status ${result.error.status}`,
            details: result.error
          });
        }
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: `Dodo request failed with status ${result.error.status}`,
          details: result.error
        });
      }
      const responseId = readString(result.data, ['subscription_id', 'id']);
      if (!responseId) {
        // A success without the subscription's id is not Dodo's not-found answer: a retry may read it.
        throw createBillFnError({ code: 'BILLFN_PROVIDER_ERROR', message: 'Dodo returned a subscription without its id' });
      }
      if (responseId !== input.providerReference) {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: 'Dodo returned a different subscription than the imported reference'
        });
      }
      return { ...mapDodoSubscriptionState(result.data), providerSubscriptionId: responseId };
    },
    async parseWebhook(input: BillFnParseWebhookInput): Promise<BillFnParsedWebhookEvent[]> {
      if (!config.webhookSecret) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo webhook parsing requires webhookSecret to be configured'
        });
      }

      const webhookId = input.headers.get('webhook-id');
      const webhookTimestamp = input.headers.get('webhook-timestamp');
      const signature = input.headers.get(webhookSignatureHeader);
      if (
        !webhookId ||
        !webhookTimestamp ||
        !signature ||
        !verifyStandardWebhookSignature(input.rawBody, {
          id: webhookId,
          timestamp: webhookTimestamp,
          signature
        }, config.webhookSecret)
      ) {
        throw createBillFnError({
          code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID',
          message: 'Dodo webhook signature verification failed'
        });
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(input.rawBody) as Record<string, unknown>;
      } catch {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Dodo webhook payload must be valid JSON'
        });
      }
      const type = readString(payload, ['type', 'event']) ?? 'unknown';
      const eventId = webhookId;
      const data = asRecord(payload.data) ?? payload;
      const recordKind = dodoWebhookRecordKind(type, data);

      return [
        {
          providerEventId: eventId,
          type,
          signatureVerified: true,
          occurredAt: readString(payload, ['timestamp', 'created_at']) ?? undefined,
          priceId: recordKind === 'other' ? undefined : readDodoPriceReference(recordKind, data),
          providerSubscriptionId: readString(data, ['subscription_id']) ?? undefined,
          providerChargeId: readString(data, ['payment_id']) ?? undefined,
          checkoutReferenceId:
            readString(data, ['checkout_session_id']) ??
            readMetadataString(data, DODO_CHECKOUT_SESSION_METADATA_KEY) ??
            undefined,
          billingState: mapDodoWebhookState(recordKind, data),
          raw: payload
        }
      ];
    }
  };
}

function createHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  };
}

function resolveDodoBaseUrl(config: DodoProviderConfig): string {
  const environment = config.environment ?? 'test_mode';
  if (environment !== 'test_mode' && environment !== 'live_mode') {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: "Dodo environment must be 'test_mode' or 'live_mode'"
    });
  }
  return (config.baseUrl ?? DODO_BASE_URLS[environment]).replace(/\/+$/, '');
}

/** A Dodo API URL; each path segment is encoded, so an identifier cannot reach another endpoint. */
function dodoUrl(baseUrl: string, segments: string[]): string {
  return `${baseUrl}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
}

/** The `POST /checkouts` body (`CreateCheckoutSessionRequest`) for the catalog price checkout selected. */
function createDodoCheckoutSessionBody(input: BillFnCreateCheckoutInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    product_cart: [{ product_id: input.price.providerProductId, quantity: 1 }],
    metadata: createDodoMetadata(input)
  };
  const email = input.customer?.email;
  if (email) {
    body.customer = input.customer?.name ? { email, name: input.customer.name } : { email };
  }
  const billingAddress = createDodoBillingAddress(input.customer?.billing);
  if (billingAddress) {
    body.billing_address = billingAddress;
  }
  const returnUrl = input.returnUrl ?? input.successUrl;
  if (returnUrl) {
    body.return_url = returnUrl;
  }
  if (input.cancelUrl) {
    body.cancel_url = input.cancelUrl;
  }
  const trialDays = input.price.trialDays;
  if (input.price.kind === 'subscription' && typeof trialDays === 'number' && Number.isSafeInteger(trialDays) && trialDays > 0) {
    body.subscription_data = { trial_period_days: trialDays };
  }
  return body;
}

/** A checkout session billing address needs its ISO country; the other fields are optional. */
function createDodoBillingAddress(billing: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const country = billing ? readString(billing, ['country']) : undefined;
  if (!billing || !country) {
    return undefined;
  }
  const address: Record<string, string> = { country };
  for (const key of ['city', 'state', 'street', 'zipcode']) {
    const value = readString(billing, [key]);
    if (value) {
      address[key] = value;
    }
  }
  return address;
}

function createDodoMetadata(input: BillFnCreateCheckoutInput): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      metadata[key] = String(value);
    }
  }
  metadata[DODO_CHECKOUT_SESSION_METADATA_KEY] = input.checkoutSessionId;
  metadata[DODO_BILLING_ACCOUNT_METADATA_KEY] = input.billingAccount.id;
  metadata[DODO_PRODUCT_METADATA_KEY] = input.price.providerProductId;
  metadata[DODO_PRICE_METADATA_KEY] = input.price.priceId;
  return metadata;
}

/** The payment that started a subscription checkout carries the checkout's metadata, and its session when known. */
function assertDodoPaymentOwnership(
  input: BillFnVerifyCheckoutInput,
  chargeId: string,
  sessionCheckoutId: string | undefined,
  payment: Record<string, unknown>
) {
  const metadata = asRecord(payment.metadata);
  if (
    readString(payment, ['payment_id']) !== chargeId ||
    metadata?.[DODO_CHECKOUT_SESSION_METADATA_KEY] !== input.checkoutSession.checkoutSessionId ||
    metadata[DODO_BILLING_ACCOUNT_METADATA_KEY] !== input.billingAccount.id ||
    metadata[DODO_PRODUCT_METADATA_KEY] !== input.price.providerProductId
  ) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: 'Dodo payment does not match the checkout session, billing account, and product'
    });
  }
  if (sessionCheckoutId) {
    assertDodoPaymentSession(sessionCheckoutId, payment);
  }
}

function assertDodoPaymentSession(sessionCheckoutId: string, payment: Record<string, unknown>) {
  if (readString(payment, ['checkout_session_id']) !== sessionCheckoutId) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: 'Dodo payment was not made through the checkout session BillFn created'
    });
  }
}

function assertDodoVerificationOwnership(
  input: BillFnVerifyCheckoutInput,
  isSubscription: boolean,
  resourceId: string,
  response: Record<string, unknown>
) {
  const responseId = isSubscription
    ? readString(response, ['subscription_id', 'id'])
    : readString(response, ['payment_id', 'id']);
  const metadata = asRecord(response.metadata);
  const productMatches = dodoProductMatches(response, isSubscription, input.price.providerProductId);
  const metadataMatches =
    metadata?.[DODO_CHECKOUT_SESSION_METADATA_KEY] === input.checkoutSession.checkoutSessionId &&
    metadata[DODO_BILLING_ACCOUNT_METADATA_KEY] === input.billingAccount.id &&
    metadata[DODO_PRODUCT_METADATA_KEY] === input.price.providerProductId;

  if (responseId !== resourceId || !productMatches || !metadataMatches) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: 'Dodo resource does not match the checkout session, billing account, and product'
    });
  }
}

function assertDodoRestoreOwnership(
  input: BillFnRestorePurchasesInput,
  isSubscription: boolean,
  response: Record<string, unknown>
) {
  const responseId = isSubscription
    ? readString(response, ['subscription_id', 'id'])
    : readString(response, ['payment_id', 'id']);
  const metadata = asRecord(response.metadata);
  const productMatches = dodoProductMatches(response, isSubscription, input.price.providerProductId);
  const metadataMatches =
    metadata?.[DODO_BILLING_ACCOUNT_METADATA_KEY] === input.billingAccount.id &&
    metadata[DODO_PRODUCT_METADATA_KEY] === input.price.providerProductId;

  if (responseId !== input.purchaseReference || !productMatches || !metadataMatches) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: 'Dodo resource does not match the purchase reference, billing account, and product'
    });
  }
}

function dodoProductMatches(
  response: Record<string, unknown>,
  isSubscription: boolean,
  providerProductId: string
) {
  return isSubscription
    ? readString(response, ['product_id']) === providerProductId
    : asArrayOfRecords(response.product_cart).some(
        (item) => readString(item, ['product_id']) === providerProductId
      );
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const response = await fetchImpl(url, init);
  const raw = await response.text();
  if (!response.ok) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: `Dodo request failed with status ${response.status}`,
      details: {
        status: response.status,
        body: raw
      }
    });
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function tryRequestJson(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  const response = await fetchImpl(url, init);
  const raw = await response.text();
  if (!response.ok) {
    return {
      ok: false as const,
      error: {
        status: response.status,
        body: raw
      }
    };
  }
  return {
    ok: true as const,
    data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  };
}

type DodoRecordKind = 'subscription' | 'payment' | 'other';

/** Whether a webhook carries a subscription, a payment, or another record (refund, dispute, license key...). */
function dodoWebhookRecordKind(type: string, data: Record<string, unknown>): DodoRecordKind {
  const payloadType = readString(data, ['payload_type']);
  if (payloadType) {
    return payloadType === 'Subscription' ? 'subscription' : payloadType === 'Payment' ? 'payment' : 'other';
  }
  const family = type.split('.')[0];
  if (family === 'subscription' || family === 'payment') {
    return family;
  }
  if (family === 'refund' || family === 'dispute' || family === 'license_key') {
    return 'other';
  }
  return readString(data, ['subscription_id']) ? 'subscription' : 'payment';
}

/**
 * The billing state a webhook record carries. A refund or dispute carries none. A payment that charges a
 * subscription names only a succeeded charge: Dodo's subscription events carry the hold, grace or failure
 * a declined renewal leads to, so a failed renewal payment does not fail the subscription.
 */
function mapDodoWebhookState(kind: DodoRecordKind, data: Record<string, unknown>): BillFnVerifiedBillingState | undefined {
  if (kind === 'subscription') {
    return mapDodoSubscriptionState(data);
  }
  if (kind === 'other') {
    return undefined;
  }
  const subscriptionId = readDodoPaymentSubscriptionId(data);
  if (!subscriptionId) {
    return mapDodoPaymentState(data);
  }
  if (normalizeDodoPaymentStatus(readString(data, ['status'])) !== 'active') {
    return undefined;
  }
  return {
    subscriptionStatus: 'active',
    checkoutStatus: 'succeeded',
    providerSubscriptionId: subscriptionId,
    providerChargeId: readString(data, ['payment_id']),
    raw: data
  };
}

function mapDodoSubscriptionState(payload: Record<string, unknown>): BillFnVerifiedBillingState {
  const normalized = normalizeDodoSubscriptionStatus(readString(payload, ['status']));
  return {
    subscriptionStatus: normalized,
    checkoutStatus: normalized === 'failed' ? 'failed' : normalized === 'pending' ? 'pending' : 'succeeded',
    providerSubscriptionId: readString(payload, ['subscription_id']),
    providerChargeId: readString(payload, ['payment_id']),
    currentPeriodStart: readString(payload, ['previous_billing_date', 'current_period_start']),
    currentPeriodEnd: readString(payload, ['next_billing_date', 'current_period_end']),
    // The renewal intent: a live, held (on_hold, paused) or past-due subscription renews unless canceled at the
    // next billing date, which keeps it active until then. A hold alone does not change the intent.
    autoRenew:
      (normalized === 'active' || normalized === 'grace' || normalized === 'paused') &&
      payload.cancel_at_next_billing_date !== true,
    raw: payload
  };
}

function mapDodoPaymentState(payload: Record<string, unknown>): BillFnVerifiedBillingState {
  const normalized = normalizeDodoPaymentStatus(readString(payload, ['status']));
  return {
    subscriptionStatus: normalized,
    checkoutStatus: normalized === 'active' ? 'succeeded' : normalized,
    providerSubscriptionId: readDodoPaymentSubscriptionId(payload),
    providerChargeId: readString(payload, ['payment_id']),
    autoRenew: false,
    raw: payload
  };
}

/** Dodo subscription statuses (`SubscriptionStatus` in Dodo's API reference). */
function normalizeDodoSubscriptionStatus(status: string | undefined): BillFnVerifiedBillingState['subscriptionStatus'] {
  switch (status) {
    case 'active':
      return 'active';
    case 'on_hold':
    case 'paused':
      return 'paused';
    case 'past_due':
      // A renewal failed and Dodo's grace period keeps access until its deadline.
      return 'grace';
    case 'cancelled':
      return 'canceled';
    case 'expired':
      return 'expired';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

/** Dodo payment statuses (`IntentStatus`): only a succeeded payment is paid, a failed or cancelled one never will be. */
function normalizeDodoPaymentStatus(status: string | undefined): 'active' | 'failed' | 'pending' {
  switch (status) {
    case 'succeeded':
      return 'active';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

/** The subscription a payment charges: its `subscription_id`, or the only entry of `subscription_ids`. */
function readDodoPaymentSubscriptionId(payment: Record<string, unknown>): string | undefined {
  const subscriptionId = readString(payment, ['subscription_id']);
  if (subscriptionId) {
    return subscriptionId;
  }
  const ids = Array.isArray(payment.subscription_ids)
    ? payment.subscription_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  return ids.length === 1 ? ids[0] : undefined;
}

/**
 * The price a webhook record names: the BillFn catalog price checkout recorded in its metadata while the record
 * still sells that price's product (a plan change moves the product, not the metadata), else the product.
 */
function readDodoPriceReference(kind: 'subscription' | 'payment', data: Record<string, unknown>): string | undefined {
  const product =
    kind === 'subscription'
      ? readString(data, ['product_id'])
      : (readString(data, ['product_id']) ?? readString(asArrayOfRecords(data.product_cart)[0] ?? {}, ['product_id']));
  const priceId = readMetadataString(data, DODO_PRICE_METADATA_KEY);
  if (priceId && product && readMetadataString(data, DODO_PRODUCT_METADATA_KEY) === product) {
    return priceId;
  }
  return product;
}

function readMetadataString(record: Record<string, unknown>, key: string): string | undefined {
  const metadata = asRecord(record.metadata);
  return metadata ? readString(metadata, [key]) : undefined;
}

/**
 * The line items of a partial refund: Dodo refunds part of a payment only per line item (`items[].item_id`), in
 * the currency the customer paid. The amount is taken from the items in order, each up to its refundable amount.
 */
function allocateDodoPartialRefund(amount: unknown, lineItems: Record<string, unknown>) {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'A Dodo partial refund amount must be a positive integer in the currency minor unit'
    });
  }
  if (lineItems.partial_refund_allowed === false) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The payment method of this Dodo payment does not allow a partial refund'
    });
  }
  const items: Array<{ item_id: string; amount: number }> = [];
  let remaining = amount;
  for (const item of asArrayOfRecords(lineItems.items)) {
    const itemId = readString(item, ['items_id', 'item_id']);
    const refundable = typeof item.refundable_amount === 'number' ? item.refundable_amount : 0;
    if (!itemId || refundable <= 0 || remaining === 0) {
      continue;
    }
    const share = Math.min(remaining, refundable);
    items.push({ item_id: itemId, amount: share });
    remaining -= share;
  }
  if (remaining > 0) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The refund amount exceeds what remains refundable on the Dodo payment',
      details: { amount, refundable: amount - remaining }
    });
  }
  const currency = readString(lineItems, ['currency']);
  return currency ? { items, currency } : { items };
}

function normalizeDodoProration(value: 'provider_default' | 'prorate' | 'none'): string {
  switch (value) {
    case 'prorate':
      return 'prorated_immediately';
    case 'none':
      return 'do_not_bill';
    default:
      return 'prorated_immediately';
  }
}

function normalizeDodoEffectiveAt(value: 'immediate' | 'next_renewal') {
  return value === 'next_renewal' ? 'next_billing_date' : 'immediately';
}

function shouldFallbackToReplacementCheckout(status: number) {
  return status === 405;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asArrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
}
