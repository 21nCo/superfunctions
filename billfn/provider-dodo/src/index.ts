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

/** How long one Dodo HTTP call, including its response body, may take before the deadline fails it. */
export const DODO_PROVIDER_HTTP_DEADLINE_MS = 30_000;

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
  /**
   * The clock that dates a refund or dispute revocation's Dodo read. Pass the same clock as BillFn's `now` when
   * the host sets one, so the revocation is ordered correctly against checkout verifications and restores.
   */
  now?: () => Date;
}

const DODO_CHECKOUT_SESSION_METADATA_KEY = 'billfn_checkout_session_id';
const DODO_BILLING_ACCOUNT_METADATA_KEY = 'billfn_billing_account_id';
const DODO_PRODUCT_METADATA_KEY = 'billfn_product_id';
const DODO_PRICE_METADATA_KEY = 'billfn_price_id';
/** Dodo payment identifiers; 0.7.0 recorded one as a checkout's provider checkout id. */
const DODO_PAYMENT_ID_PREFIX = 'pay_';
/** The currency of the catalog price the checkout sold, in which BillFn records the payment's refunds. */
const DODO_CURRENCY_METADATA_KEY = 'billfn_currency';

export function createDodoProvider(config: DodoProviderConfig): BillFnProviderAdapter {
  const fetchImpl = config.fetch ?? fetch;
  const baseUrl = resolveDodoBaseUrl(config);
  const webhookSignatureHeader = (config.webhookSignatureHeader ?? 'webhook-signature').toLowerCase();
  const get = (...segments: string[]) =>
    requestJson(fetchImpl, dodoUrl(baseUrl, segments), { method: 'GET', headers: createHeaders(config.apiKey) });
  /**
   * The billing state of a one-time purchase whose money went back: a full refund that succeeded, or a dispute the
   * merchant lost or accepted. The charge's payment is read from Dodo to tell a one-time purchase from a
   * subscription charge: a one-time purchase is revoked (`canceled`); a subscription charge is left to Dodo's
   * subscription events, which carry whatever Dodo did with the subscription. A partial refund also reads the
   * payment and revokes only once Dodo reports the payment's `refund_status` as `full`. Failed refunds and the disputes that
   * leave the money with the merchant (opened, challenged, won) read nothing.
   *
   * The state is dated when the read started (or at the signed event time, when that is later), so a verification
   * BillFn applied in between does not make it look stale. A payment answer that is not the payment asked for, or that does not say whether it belongs to a
   * subscription, fails the delivery, so Dodo retries it.
   */
  const readDodoRevocationState = async (
    type: string,
    data: Record<string, unknown>
  ): Promise<{ state: BillFnVerifiedBillingState; observedAt: string } | undefined> => {
    const paymentId = readString(data, ['payment_id']);
    const revocation = isDodoRevocationEvent(type, data);
    if (!paymentId || !revocation) {
      return undefined;
    }
    const observedAt = (config.now?.() ?? new Date()).toISOString();
    const payment = asPlainRecord(await get('payments', paymentId));
    if (!payment || readString(payment, ['payment_id']) !== paymentId) {
      throw unusableDodoRead(`payment ${paymentId}`);
    }
    const kind = classifyDodoPayment(payment);
    if (kind === 'unknown') {
      throw unusableDodoRead(`payment ${paymentId}`);
    }
    if (kind === 'subscription') {
      return undefined;
    }
    // A partial refund revokes the purchase once Dodo reports the payment fully refunded (it marks the refund of a
    // remaining balance as partial too).
    if (revocation === 'partial' && !isDodoPaymentRevoked(payment)) {
      // A payment read that does not list the delivered refund as succeeded yet is stale: its refund_status may
      // not count this refund, so the delivery fails and Dodo retries it once the payment catches up.
      const refundId = readString(data, ['refund_id']);
      const listed = (Array.isArray(payment.refunds) ? payment.refunds : []).some((refund) => {
        const record = asPlainRecord(refund);
        return record !== null && readString(record, ['refund_id']) === refundId && readString(record, ['status']) === 'succeeded';
      });
      if (refundId && !listed) {
        throw unusableDodoRead(`payment ${paymentId} (refund ${refundId} not listed yet)`);
      }
      return undefined;
    }
    return {
      state: {
        subscriptionStatus: 'canceled',
        checkoutStatus: 'succeeded',
        providerChargeId: paymentId,
        autoRenew: false,
        raw: data
      },
      observedAt
    };
  };
  const patchInit = (body: Record<string, unknown>): RequestInit => ({
    method: 'PATCH',
    headers: createHeaders(config.apiKey),
    body: JSON.stringify(body)
  });
  /** A subscription PATCH whose non-2xx answer fails the operation; a 2xx answer commits it whatever its body. */
  const patchSubscription = async (providerSubscriptionId: string, body: Record<string, unknown>) => {
    const response = await sendDodoRequest(
      fetchImpl,
      dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]),
      patchInit(body)
    );
    if (!response.ok) {
      throw createBillFnError({
        code: 'BILLFN_PROVIDER_ERROR',
        message: `Dodo request failed with status ${response.error.status}`,
        details: response.error
      });
    }
    return response;
  };

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
      const response = await requestJson(
        fetchImpl,
        dodoUrl(baseUrl, ['checkouts']),
        {
          method: 'POST',
          headers: createHeaders(config.apiKey),
          body: JSON.stringify(createDodoCheckoutSessionBody(input))
        },
        'Dodo created the checkout but its session details did not arrive before the deadline'
      );
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
      const recordedCheckoutId = input.checkoutSession.providerCheckoutId;
      // 0.7.0 created payment links and recorded their payment as the checkout: such a row has no checkout session,
      // and its recorded payment is the one to verify.
      const legacyPaymentId =
        recordedCheckoutId &&
        (recordedCheckoutId === input.checkoutSession.providerChargeId ||
          recordedCheckoutId.startsWith(DODO_PAYMENT_ID_PREFIX))
          ? recordedCheckoutId
          : undefined;
      const providerCheckoutId = legacyPaymentId ? undefined : recordedCheckoutId;
      const recordedChargeId = input.checkoutSession.providerChargeId ?? legacyPaymentId;
      let subscriptionId =
        input.checkoutSession.providerSubscriptionId ??
        readString(input.payload ?? {}, ['subscriptionId', 'subscription_id']);
      let chargeId = recordedChargeId ?? readString(input.payload ?? {}, ['paymentId', 'payment_id']);
      let sessionCheckoutId: string | undefined;
      // A charge BillFn links to the subscription must be server-recorded or read from Dodo, never only client-sent.
      let chargeVerified = Boolean(recordedChargeId);

      /** The payment the checkout session names now: after a declined payment, the customer's retry. */
      const readSessionPaymentId = async (): Promise<string> => {
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
        const sessionPaymentId = readString(session, ['payment_id']);
        if (!sessionPaymentId) {
          throw createBillFnError({
            code: 'BILLFN_CONFLICT',
            message: 'The Dodo checkout session has no payment yet; verify again after the customer pays',
            details: { checkoutStatus: 'pending' }
          });
        }
        sessionCheckoutId = providerCheckoutId;
        chargeVerified = true;
        return sessionPaymentId;
      };
      /**
       * A failed payment not read through the session may have been retried inside it; the session's
       * current payment replaces it. Returns the payment to verify, read again only when it changed.
       */
      const followSessionRetry = async (payment: Record<string, unknown>) => {
        if (
          sessionCheckoutId ||
          !providerCheckoutId ||
          !chargeId ||
          normalizeDodoPaymentStatus(readString(payment, ['status'])) !== 'failed'
        ) {
          return payment;
        }
        const latest = await readSessionPaymentId();
        if (latest === chargeId) {
          return payment;
        }
        chargeId = latest;
        return get('payments', latest);
      };

      if (!chargeId && (!isSubscription || !subscriptionId)) {
        chargeId = await readSessionPaymentId();
      }

      if (isSubscription && !subscriptionId && chargeId) {
        const first = await get('payments', chargeId);
        assertDodoPaymentOwnership(input, chargeId, sessionCheckoutId, first);
        const payment = await followSessionRetry(first);
        if (payment !== first) {
          assertDodoPaymentOwnership(input, chargeId, sessionCheckoutId, payment);
        }
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

      let response = await get(isSubscription ? 'subscriptions' : 'payments', resourceId);
      assertDodoVerificationOwnership(input, isSubscription, resourceId, response);
      if (!isSubscription) {
        const retried = await followSessionRetry(response);
        if (retried !== response) {
          response = retried;
          assertDodoVerificationOwnership(input, false, chargeId as string, response);
        }
        if (sessionCheckoutId) {
          assertDodoPaymentSession(sessionCheckoutId, response);
        }
        // Ownership matched the payment to the checkout's one-time price, so it is a one-time purchase.
        return mapDodoPaymentState(response, 'one_time');
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
        billingState: mapCommittedDodoSubscription(providerSubscriptionId, response),
        raw: committedRaw(response)
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

      const attempted = await sendDodoRequest(
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
        const changePlan = asPlainRecord(attempted.data);
        const paymentLink = changePlan ? readString(changePlan, ['payment_link']) : undefined;
        if (paymentLink) {
          return {
            operationStatus: 'requires_action',
            clientAction: {
              type: 'redirect',
              url: paymentLink,
              metadata: { action: 'plan-change-payment', paymentId: changePlan ? readString(changePlan, ['payment_id']) : undefined }
            },
            raw: committedRaw(attempted)
          } satisfies BillFnProviderOperationResult;
        }
        // The change is committed at Dodo: no failure of this read (status, transport, body, JSON or an answer that
        // is not this subscription) may report it as failed. An unusable read of an immediate change still gives
        // BillFn a state so it records the target price: the stored subscription's own, with no Dodo fact added.
        // Without one BillFn keeps the old price, and a target sharing its Dodo product would never be recorded,
        // since later webhooks name only the product. The next webhook or sync brings Dodo's state.
        const subscription = await sendDodoFollowUp(fetchImpl, dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]), {
          method: 'GET',
          headers: createHeaders(config.apiKey)
        });
        const readState = subscription.ok ? mapCommittedDodoSubscription(providerSubscriptionId, subscription) : undefined;
        return {
          operationStatus: 'applied',
          billingState:
            readState ??
            (input.effectiveAt === 'immediate' ? storedDodoSubscriptionState(input.subscription, providerSubscriptionId) : undefined),
          raw: subscription.ok
            ? { changePlan: committedRaw(attempted), subscription: committedRaw(subscription) }
            : { changePlan: committedRaw(attempted), subscriptionReadError: subscription.error }
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
        billingState:
          input.effectiveAt === 'immediate' ? mapCommittedDodoSubscription(providerSubscriptionId, cancellation) : undefined,
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
          cancellation: committedRaw(cancellation)
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
      const paused = input.subscription.status === 'paused';
      const attempted = await sendDodoRequest(
        fetchImpl,
        dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]),
        patchInit(paused ? { status: 'active' } : { cancel_at_next_billing_date: false })
      );

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

      // A held subscription can also be scheduled to cancel: resuming it clears that too, in a second request.
      // An unreadable answer leaves the scheduled cancel to the stored renewal intent.
      const resumed = asPlainRecord(attempted.data);
      const scheduledCancel = resumed?.cancel_at_next_billing_date;
      if (paused && (scheduledCancel === true || (scheduledCancel === undefined && !input.subscription.autoRenew))) {
        const cleared = await sendDodoFollowUp(
          fetchImpl,
          dodoUrl(baseUrl, ['subscriptions', providerSubscriptionId]),
          patchInit({ cancel_at_next_billing_date: false })
        );
        if (!cleared.ok) {
          // The subscription is active again but still ends at its next billing date: BillFn records that state
          // when Dodo's answer to the resume showed it.
          return {
            operationStatus: 'requires_action',
            billingState: resumed
              ? mapCommittedDodoSubscription(providerSubscriptionId, {
                  ok: true,
                  data: { cancel_at_next_billing_date: true, ...resumed }
                })
              : undefined,
            clientAction: {
              type: 'redirect',
              metadata: {
                action: 'contact-support'
              }
            },
            raw: {
              resumed: committedRaw(attempted),
              cancellationClearError: cleared.error
            }
          } satisfies BillFnProviderOperationResult;
        }
        return {
          operationStatus: 'applied',
          billingState: mapCommittedDodoSubscription(providerSubscriptionId, cleared),
          raw: { resumed: committedRaw(attempted), cancellationCleared: committedRaw(cleared) }
        } satisfies BillFnProviderOperationResult;
      }

      return {
        operationStatus: 'applied',
        billingState: mapCommittedDodoSubscription(providerSubscriptionId, attempted),
        raw: committedRaw(attempted)
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
        assertDodoRefundAmount(input.amount);
        // BillFn records the amount in the currency of the subscription's current catalog price; Dodo refunds it in
        // the currency the customer paid, so the two must be shown to be the same before any money moves.
        const payment = await get('payments', paymentId);
        const markers = await readDodoRefundMarkers(payment, (subscriptionId) => get('subscriptions', subscriptionId));
        const currency = assertDodoRefundCurrency(input, payment, markers);
        // Dodo refunds part of a payment only through its line items, each up to its refundable amount, read in
        // the paid currency (without it Dodo answers in the settlement currency).
        const lineItems = await requestJson(fetchImpl, dodoUrl(baseUrl, ['payments', paymentId, 'line-items'], { currency }), {
          method: 'GET',
          headers: createHeaders(config.apiKey)
        });
        Object.assign(refundBody, { items: allocateDodoPartialRefund(input.amount, lineItems, currency), currency });
      }

      const response = await sendDodoRequest(fetchImpl, dodoUrl(baseUrl, ['refunds']), {
        method: 'POST',
        headers: createHeaders(config.apiKey),
        body: JSON.stringify(refundBody)
      });
      if (!response.ok) {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: `Dodo request failed with status ${response.error.status}`,
          details: response.error
        });
      }
      // Dodo accepted the refund: an unreadable answer still records it, without its id.
      const refund = asPlainRecord(response.data) ?? {};
      if (readString(refund, ['status']) === 'failed') {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: 'Dodo reported the refund as failed',
          details: { refundId: readString(refund, ['refund_id']), status: 'failed' }
        });
      }

      // A full refund of a one-time purchase is revoked by its refund.succeeded webhook.
      return {
        operationStatus: 'applied',
        providerRefundId: readString(refund, ['refund_id', 'id']),
        raw: committedRaw(response)
      } satisfies BillFnProviderOperationResult;
    },
    async restorePurchases(input: BillFnRestorePurchasesInput) {
      const isSubscription = input.price.kind === 'subscription';
      const response = await get(isSubscription ? 'subscriptions' : 'payments', input.purchaseReference);

      assertDodoRestoreOwnership(input, isSubscription, response);

      // Ownership matched a non-subscription restore to its one-time price, so the payment is a one-time purchase.
      return [isSubscription ? mapDodoSubscriptionState(response) : mapDodoPaymentState(response, 'one_time')];
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
      const revocation = recordKind === 'other' ? await readDodoRevocationState(type, data) : undefined;
      const billingState = recordKind === 'other' ? revocation?.state : mapDodoWebhookState(recordKind, data);

      return [
        {
          providerEventId: eventId,
          type,
          signatureVerified: true,
          occurredAt: revocation
            ? laterTimestamp(revocation.observedAt, readString(payload, ['timestamp', 'created_at']))
            : (readString(payload, ['timestamp', 'created_at']) ?? undefined),
          priceId: recordKind === 'other' ? undefined : readDodoPriceReference(recordKind, data),
          providerSubscriptionId: readString(data, ['subscription_id']) ?? undefined,
          providerChargeId: readString(data, ['payment_id']) ?? undefined,
          // A refund or dispute links only through its charge: its own metadata is not the checkout's.
          checkoutReferenceId:
            recordKind === 'other'
              ? undefined
              : (readString(data, ['checkout_session_id']) ??
                readMetadataString(data, DODO_CHECKOUT_SESSION_METADATA_KEY) ??
                undefined),
          // Dodo's own checkout_session_id is the provider's; the metadata key is whatever the payer's link set.
          checkoutReferenceSource:
            recordKind === 'other'
              ? undefined
              : readString(data, ['checkout_session_id'])
                ? 'provider'
                : readMetadataString(data, DODO_CHECKOUT_SESSION_METADATA_KEY)
                  ? 'metadata'
                  : undefined,
          billingState,
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
  return trimTrailingSlashes(config.baseUrl ?? DODO_BASE_URLS[environment]);
}

/** Drops trailing `/` characters in one backward scan (linear time; no regex backtracking on caller input). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 0x2f) {
    end -= 1;
  }
  return value.slice(0, end);
}

/** A Dodo API URL; each path segment is encoded, so an identifier cannot reach another endpoint. */
function dodoUrl(baseUrl: string, segments: string[], query?: Record<string, string>): string {
  const path = `${baseUrl}/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  return query ? `${path}?${new URLSearchParams(query).toString()}` : path;
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
  metadata[DODO_CURRENCY_METADATA_KEY] = input.price.currency.toUpperCase();
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

function isMutatingMethod(method: string | undefined): boolean {
  const normalized = (method ?? 'GET').toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

function dodoDeadlineError(mutating: boolean) {
  return createBillFnError({
    code: 'BILLFN_PROVIDER_ERROR',
    message: mutating
      ? 'Dodo did not answer before the deadline; whether the change was applied is unknown'
      : 'Dodo did not answer before the deadline; the read can be retried',
    retryable: !mutating
  });
}

async function fetchDodoText(
  fetchImpl: typeof fetch,
  url: string,
  init: Omit<RequestInit, 'signal'>,
  tolerateBodyErrors = false
): Promise<{ response: Response; raw: string; bodyError?: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Dodo HTTP deadline');
      reject(error);
      controller.abort(error);
    }, DODO_PROVIDER_HTTP_DEADLINE_MS);
  });
  let response: Response | undefined;
  try {
    const request = async () => {
      const fetched = await fetchImpl(url, { ...init, signal: controller.signal });
      controller.signal.throwIfAborted();
      response = fetched;
      return { response: fetched, raw: await fetched.text() };
    };
    return await Promise.race([request(), expired]);
  } catch (error) {
    if (controller.signal.aborted) {
      if (!response) {
        throw dodoDeadlineError(isMutatingMethod(init.method));
      }
      const bodyError = response.ok && isMutatingMethod(init.method)
        ? 'Dodo accepted the change but the response body did not arrive before the deadline'
        : 'Dodo response body did not arrive before the deadline';
      return { response, raw: '', bodyError };
    }
    if (response && tolerateBodyErrors) {
      return { response, raw: '', bodyError: describeError(error) };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(fetchImpl: typeof fetch, url: string, init: RequestInit, acceptedBodyDeadlineMessage?: string) {
  const result = await tryRequestJson(fetchImpl, url, init, acceptedBodyDeadlineMessage);
  if (!result.ok) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: `Dodo request failed with status ${result.error.status}`,
      details: result.error
    });
  }
  return result.data;
}

async function tryRequestJson(fetchImpl: typeof fetch, url: string, init: RequestInit, acceptedBodyDeadlineMessage?: string) {
  const { response, raw, bodyError } = await fetchDodoText(fetchImpl, url, init);
  if (!response.ok) {
    return { ok: false as const, error: { status: response.status, body: raw } };
  }
  if (bodyError) {
    if (!isMutatingMethod(init.method)) {
      throw dodoDeadlineError(false);
    }
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: acceptedBodyDeadlineMessage ?? bodyError,
      details: { status: response.status },
      retryable: false
    });
  }
  return { ok: true as const, data: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

type DodoRequestError = { status: number; body: string };
/** A 2xx answer to a request that changes the subscription: the change is committed whatever the body holds. */
type DodoCommittedResponse = { ok: true; data: unknown; bodyError?: string };
type DodoMutationResponse = DodoCommittedResponse | { ok: false; error: DodoRequestError };

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Sends a Dodo mutation or a read after a committed mutation. The status is authoritative even if reading
 * the body fails. A successful mutation can proceed without decoded state.
 */
async function sendDodoRequest(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<DodoMutationResponse> {
  const { response, raw, bodyError } = await fetchDodoText(fetchImpl, url, init, true);
  if (!response.ok) {
    return { ok: false, error: { status: response.status, body: raw } };
  }
  if (bodyError) {
    return { ok: true, data: undefined, bodyError };
  }
  if (!raw) {
    return { ok: true, data: undefined };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: true, data: undefined, bodyError: describeError(error) };
  }
}

/** A request made after a committed change: every failure, a transport one included, is returned, never thrown. */
async function sendDodoFollowUp(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<DodoMutationResponse> {
  try {
    return await sendDodoRequest(fetchImpl, url, init);
  } catch (error) {
    return { ok: false, error: { status: 0, body: describeError(error) } };
  }
}

/** The diagnostic record of a committed answer, whatever its body was. */
function committedRaw(response: DodoCommittedResponse): Record<string, unknown> {
  const record = asPlainRecord(response.data);
  if (record && !response.bodyError) {
    return record;
  }
  return response.bodyError ? { body: null, bodyError: response.bodyError } : { body: response.data ?? null };
}

/**
 * The billing state a committed subscription change answered with. Only an object for this subscription (its
 * `subscription_id` equal when present) with a Dodo `SubscriptionStatus` is a state; anything else gives none,
 * so BillFn keeps its row until the next webhook or sync instead of recording a fabricated one.
 */
function mapCommittedDodoSubscription(
  providerSubscriptionId: string,
  response: DodoCommittedResponse
): BillFnVerifiedBillingState | undefined {
  const record = asPlainRecord(response.data);
  if (!record || response.bodyError) {
    return undefined;
  }
  const responseId = record.subscription_id;
  if (responseId !== undefined && responseId !== null && responseId !== providerSubscriptionId) {
    return undefined;
  }
  const status = record.status;
  if (typeof status !== 'string' || !DODO_SUBSCRIPTION_STATUSES.has(status)) {
    return undefined;
  }
  return { ...mapDodoSubscriptionState(record), providerSubscriptionId };
}

/**
 * The stored subscription's state, for a committed change whose Dodo state could not be read: only what BillFn
 * already recorded, so applying it changes nothing but the price and plan the change selected. It carries no raw
 * record, so BillFn reads no product from it and adds nothing to the subscription's metadata.
 */
function storedDodoSubscriptionState(
  subscription: BillFnChangeSubscriptionInput['subscription'],
  providerSubscriptionId: string
): BillFnVerifiedBillingState {
  return {
    subscriptionStatus: subscription.status,
    checkoutStatus:
      subscription.status === 'failed' ? 'failed' : subscription.status === 'pending' ? 'pending' : 'succeeded',
    providerSubscriptionId,
    ...(subscription.providerChargeId ? { providerChargeId: subscription.providerChargeId } : {}),
    ...(subscription.currentPeriodStart ? { currentPeriodStart: subscription.currentPeriodStart } : {}),
    ...(subscription.currentPeriodEnd ? { currentPeriodEnd: subscription.currentPeriodEnd } : {}),
    autoRenew: subscription.autoRenew
  };
}

/**
 * Whether a refund or dispute event may take a charge's money back: `full` for a full refund or a lost or accepted
 * dispute, `partial` for a partial refund (which revokes only once Dodo reports the payment's `refund_status` as `full`).
 */
function isDodoRevocationEvent(type: string, data: Record<string, unknown>): 'full' | 'partial' | null {
  if (type === 'refund.succeeded') {
    if (readString(data, ['status']) === 'failed') {
      return null;
    }
    return data.is_partial === false ? 'full' : 'partial';
  }
  return type === 'dispute.lost' || type === 'dispute.accepted' ? 'full' : null;
}

/** Dodo's `SubscriptionStatus` values (and `paused`, which older answers report for a held subscription). */
const DODO_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'active',
  'on_hold',
  'paused',
  'past_due',
  'cancelled',
  'expired',
  'failed'
]);

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
  // A subscription Dodo charged renews (a scheduled cancel stops the charges), and a payment received before its
  // subscription's event may create BillFn's row: it starts with the renewal intent, not without it.
  return {
    subscriptionStatus: 'active',
    checkoutStatus: 'succeeded',
    providerSubscriptionId: subscriptionId,
    providerChargeId: readString(data, ['payment_id']),
    autoRenew: true,
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

/** Whether a payment names a subscription it charges (as opposed to only flagging `is_multi_subscription`). */
function hasDodoPaymentSubscriptionId(payment: Record<string, unknown>): boolean {
  return (
    (typeof payment.subscription_id === 'string' && payment.subscription_id.length > 0) ||
    (Array.isArray(payment.subscription_ids) && payment.subscription_ids.length > 0)
  );
}

/**
 * Whether a payment is a one-time purchase or charges one or more subscriptions. Any subscription id, a non-empty
 * `subscription_ids` or `is_multi_subscription` means a subscription charge. One-time only when Dodo says so: a
 * `null` `subscription_id`, or (Dodo may omit that optional field) an empty `subscription_ids` list.
 */
function classifyDodoPayment(payment: Record<string, unknown>): 'one_time' | 'subscription' | 'unknown' {
  if (hasDodoPaymentSubscriptionId(payment) || payment.is_multi_subscription === true) {
    return 'subscription';
  }
  return payment.subscription_id === null || Array.isArray(payment.subscription_ids) ? 'one_time' : 'unknown';
}

/**
 * Whether a payment's money went back: a succeeded full refund, or a dispute the merchant lost or accepted. Dodo
 * keeps such a payment's own status `succeeded`, and records the refunds and disputes beside it.
 */
function isDodoPaymentRevoked(payment: Record<string, unknown>): boolean {
  const refunds = Array.isArray(payment.refunds) ? payment.refunds : [];
  const disputes = Array.isArray(payment.disputes) ? payment.disputes : [];
  return (
    // Dodo's own judgement of the payment: `full` once its refunds returned all of it, including refunds in
    // installments, each of which (the last included) Dodo marks as partial.
    readString(payment, ['refund_status']) === 'full' ||
    refunds.some((refund) => {
      const record = asPlainRecord(refund);
      return record !== null && record.is_partial === false && readString(record, ['status']) === 'succeeded';
    }) ||
    disputes.some((dispute) => {
      const status = readString(asPlainRecord(dispute) ?? {}, ['dispute_status']);
      return status === 'dispute_lost' || status === 'dispute_accepted';
    })
  );
}

/**
 * A payment's billing state. `knownKind` is the purchase kind the caller already established (checkout
 * verification and restore match the payment to a one-time price first); without it the payment's own
 * subscription fields decide.
 */
function mapDodoPaymentState(
  payload: Record<string, unknown>,
  knownKind?: 'one_time'
): BillFnVerifiedBillingState {
  const paid = normalizeDodoPaymentStatus(readString(payload, ['status']));
  // A one-time purchase whose money went back no longer grants access, whichever read (verification, restore,
  // a payment webhook) sees it; a subscription charge leaves that to the subscription's own state.
  // The caller's one-time price decides only when the payment's own fields are inconclusive; a payment that names
  // a subscription (a cart mixing a one-time item with a subscription) is never projected as a revoked one-time
  // purchase, which would cancel the subscription it names.
  const namesSubscription = hasDodoPaymentSubscriptionId(payload);
  const kind = knownKind && !namesSubscription ? knownKind : classifyDodoPayment(payload);
  const reversed = paid === 'active' && isDodoPaymentRevoked(payload);
  if (reversed && knownKind === 'one_time' && namesSubscription) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: 'The refunded Dodo payment also charges a subscription; BillFn cannot revoke its one-time item alone'
    });
  }
  const revoked = reversed && kind !== 'subscription';
  if (revoked && kind === 'unknown') {
    // A reversed payment that does not say whether it is a one-time purchase is neither granted nor revoked.
    throw unusableDodoRead(`payment ${readString(payload, ['payment_id']) ?? ''}`.trim());
  }
  const normalized = revoked ? 'canceled' : paid;
  return {
    subscriptionStatus: normalized,
    checkoutStatus: paid === 'active' ? 'succeeded' : paid,
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
 * The price a webhook record names. Checkout metadata is historical: Dodo keeps it on a subscription and its payments
 * through every plan change, so a subscription record or subscription payment names only its current product and
 * core picks the price with the subscription's stored selection. Only a one-time payment, whose product never
 * changes, names the catalog price its checkout recorded, and only while it still sells that price's product.
 */
function readDodoPriceReference(kind: 'subscription' | 'payment', data: Record<string, unknown>): string | undefined {
  if (kind === 'subscription') {
    return readString(data, ['product_id']);
  }
  // A cart lists a payment's one-time items, so it names the product only for a payment that charges no
  // subscription; a subscription payment's own product is in product_id, if anywhere.
  const product =
    readString(data, ['product_id']) ??
    (isDodoOneTimePayment(data) ? readString(asArrayOfRecords(data.product_cart)[0] ?? {}, ['product_id']) : undefined);
  const priceId = readMetadataString(data, DODO_PRICE_METADATA_KEY);
  if (
    priceId &&
    product &&
    isDodoOneTimePayment(data) &&
    readMetadataString(data, DODO_PRODUCT_METADATA_KEY) === product
  ) {
    return priceId;
  }
  return product;
}

/** A payment Dodo says charges no subscription (the one classification `classifyDodoPayment` gives). */
function isDodoOneTimePayment(payment: Record<string, unknown>): boolean {
  return classifyDodoPayment(payment) === 'one_time';
}

function readMetadataString(record: Record<string, unknown>, key: string): string | undefined {
  const metadata = asRecord(record.metadata);
  return metadata ? readString(metadata, [key]) : undefined;
}

/**
 * A line item's refundable balance, in minor units. A missing or non-numeric balance is unused. A number that is
 * not a nonnegative safe integer is refused: it is not a minor-unit amount BillFn can send back to Dodo.
 */
function readRefundableMinorUnits(item: Record<string, unknown>): number {
  const refundable = item.refundable_amount;
  if (typeof refundable !== 'number') {
    return 0;
  }
  if (!Number.isSafeInteger(refundable) || refundable < 0) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Dodo returned a refundable balance that is not a nonnegative integer in minor units',
      retryable: false
    });
  }
  return refundable;
}

function assertDodoRefundAmount(amount: unknown): asserts amount is number {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'A Dodo partial refund amount must be a positive integer in the currency minor unit'
    });
  }
}

/** The catalog price and currency checkout recorded for a payment, in the metadata Dodo copied it to. */
interface DodoRefundMarkers {
  priceId?: string;
  currency?: string;
  source: 'payment' | 'subscription' | 'none';
}

/**
 * A payment's checkout markers: its own metadata, or for a subscription payment that lacks them (a renewal carries
 * none), the metadata of the subscription it charged. Both markers come from the same record.
 */
async function readDodoRefundMarkers(
  payment: Record<string, unknown>,
  readSubscription: (subscriptionId: string) => Promise<Record<string, unknown>>
): Promise<DodoRefundMarkers> {
  const fromRecord = (record: Record<string, unknown>) => ({
    priceId: readMetadataString(record, DODO_PRICE_METADATA_KEY),
    currency: readMetadataString(record, DODO_CURRENCY_METADATA_KEY)?.toUpperCase()
  });
  const own = fromRecord(payment);
  if (own.priceId && own.currency) {
    return { ...own, source: 'payment' };
  }
  const subscriptionId = readDodoPaymentSubscriptionId(payment);
  if (!subscriptionId) {
    return { source: 'none' };
  }
  const subscription = asPlainRecord(await readSubscription(subscriptionId));
  if (!subscription || readString(subscription, ['subscription_id']) !== subscriptionId) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Dodo returned a different subscription than the one the payment charged'
    });
  }
  return { ...fromRecord(subscription), source: 'subscription' };
}

/**
 * The currency of a partial refund: the one the customer paid, which must be the currency of the catalog price
 * checkout recorded, and that price must be the subscription's current one, because BillFn records the refunded
 * amount in the current price's currency.
 */
function assertDodoRefundCurrency(
  input: BillFnRefundChargeInput,
  payment: Record<string, unknown>,
  markers: DodoRefundMarkers
): string {
  const paid = readString(payment, ['currency'])?.toUpperCase();
  if (!paid) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Dodo returned a payment without its currency'
    });
  }
  const details = {
    paymentCurrency: paid,
    catalogCurrency: markers.currency,
    checkoutPriceId: markers.priceId,
    subscriptionPriceId: input.subscription?.priceId,
    markerSource: markers.source
  };
  if (!markers.priceId || !markers.currency) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The Dodo payment does not record the catalog price and currency; refund it in full or in Dodo',
      details
    });
  }
  if (input.subscription && markers.priceId !== input.subscription.priceId) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The Dodo payment was made for a different catalog price than the current one; refund it in full or in Dodo',
      details
    });
  }
  if (input.currency !== undefined && (typeof input.currency !== 'string' || input.currency.toUpperCase() !== paid)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The refund amount is in a different currency than the Dodo payment; refund it in full or in Dodo',
      details: { ...details, refundCurrency: input.currency }
    });
  }
  if (markers.currency !== paid) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'The Dodo payment was made in a different currency than the catalog price; refund it in full or in Dodo',
      details
    });
  }
  return paid;
}

/**
 * The line items of a partial refund: Dodo refunds part of a payment only per line item (`items[].item_id`). The
 * amount is taken from the items in order, each up to its refundable amount in the paid currency.
 */
function allocateDodoPartialRefund(amount: number, lineItems: Record<string, unknown>, currency: string) {
  const lineItemsCurrency = readString(lineItems, ['currency'])?.toUpperCase();
  if (lineItemsCurrency && lineItemsCurrency !== currency) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Dodo returned the payment line items in a different currency than the one requested',
      details: { requested: currency, returned: lineItemsCurrency }
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
    // A fractional or unsafe balance would be sent back to Dodo as the refund amount. Refuse it before any refund
    // is posted, including when an earlier line item could have covered the amount on its own.
    const refundable = readRefundableMinorUnits(item);
    const itemId = readString(item, ['items_id', 'item_id']);
    if (!itemId || refundable === 0 || remaining === 0) {
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
  return items;
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

/**
 * The later of two times: a revocation is dated no earlier than its signed event time, so a provider clock running
 * ahead of BillFn's cannot make it look older than the payment it revokes.
 */
function laterTimestamp(local: string, signed: string | undefined): string {
  const signedMs = signed === undefined ? Number.NaN : Date.parse(signed);
  return Number.isFinite(signedMs) && signedMs > Date.parse(local) ? signed! : local;
}

/** A retryable failure for a Dodo read whose answer is not the record asked for. */
function unusableDodoRead(resource: string) {
  return createBillFnError({
    code: 'BILLFN_PROVIDER_ERROR',
    message: `Dodo answered the read of ${resource} with an unusable record`
  });
}

/** A JSON object: not null, not an array. */
function asPlainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    : [];
}
