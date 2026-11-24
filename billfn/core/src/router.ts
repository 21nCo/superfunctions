import { createRouter, type Route } from '@superfunctions/http';
import { createBillFnError } from './errors.js';
import { errorResponse, jsonResponse, readBoundedBytes, successResponse } from './http.js';
import { normalizeBasePath, resolveRequestSubject } from './helpers.js';
import { assertCheckoutMetadata, createBillFnService } from './service.js';
import type {
  BillFnConfig,
  BillFnRefundAuthorizationInput,
  BillFnReconciliationJobKind,
  BillableSubject,
  BillingProviderName
} from './types.js';

const PROVIDER_NAMES: ReadonlySet<string> = new Set<BillingProviderName>([
  'dodo',
  'apple',
  'stripe',
  'polar',
  'google-play',
  'microsoft-store'
]);
/** The longest provider reference the owner lookup accepts. */
const MAX_PROVIDER_REFERENCE_LENGTH = 512;

/** Compares SHA-256 digests in constant time, so the comparison time does not reveal the token. */
async function tokensMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match ? match[1] : null;
}

/** The largest request body the router reads: account routes and provider webhooks are a few kilobytes. */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** Reads a request body as text, refusing one larger than MAX_REQUEST_BODY_BYTES before or while reading it. */
async function readBoundedText(request: Request): Promise<string> {
  let bytes: Awaited<ReturnType<typeof readBoundedBytes>>;
  try {
    bytes = await readBoundedBytes(request, MAX_REQUEST_BODY_BYTES);
  } catch {
    // The body could not be read (a stream locked by middleware, a broken connection).
    throw createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message: 'The request body could not be read' });
  }
  if (bytes === 'too_large') {
    throw bodyTooLarge();
  }
  if (bytes === 'already_read') {
    throw createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message: 'The request body was already read before BillFn' });
  }
  return new TextDecoder().decode(bytes);
}

function bodyTooLarge() {
  return createBillFnError({
    code: 'BILLFN_VALIDATION_ERROR',
    message: `Request body must be at most ${MAX_REQUEST_BODY_BYTES} bytes`
  });
}

/** RFC 9110 media type: `type/subtype` then `; name=value` parameters, each value a token or a quoted string. */
const TOKEN = "[a-z0-9!#$%&'*+.^_`|~-]+";
const QUOTED_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const MEDIA_TYPE_HEADER = new RegExp(
  `^[ \\t]*(${TOKEN})/(${TOKEN})(?:[ \\t]*;[ \\t]*(?:${TOKEN}=(?:${TOKEN}|${QUOTED_STRING}))?)*[ \\t]*$`,
  'i'
);

/**
 * application/json, or a type/subtype with the +json structured suffix. The whole header must be one well-formed
 * media type: a combined header (`application/json, text/plain`), a parameter without a value (`; charset`) or an
 * unterminated quoted value is refused; quoted values may hold commas and escaped quotes.
 */
function isJsonContentType(header: string | null) {
  const match = header ? MEDIA_TYPE_HEADER.exec(header) : null;
  if (!match) {
    return false;
  }
  const type = match[1]!.toLowerCase();
  const subtype = match[2]!.toLowerCase();
  return (type === 'application' && subtype === 'json') || (subtype.endsWith('+json') && subtype.length > '+json'.length);
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  // A JSON content type is required, so a cross-site form post (text/plain, sent without a CORS preflight) is
  // refused instead of parsed.
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Request body must be sent as application/json'
    });
  }
  const text = await readBoundedText(request);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Request body must contain valid JSON'
    });
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Request body must contain a JSON object'
    });
  }

  return body as T;
}

export function createBillFnRouter(config: BillFnConfig) {
  const service = createBillFnService(config);
  const ensureOperationsAuthorized = async (request: Request) => {
    const authorized = await (config.operations?.authorize?.(request) ?? false);
    if (!authorized) {
      throw createBillFnError({
        code: 'BILLFN_UNAUTHORIZED',
        message: 'Operations access is not authorized'
      });
    }
  };
  const ensureRefundAuthorized = async (input: BillFnRefundAuthorizationInput) => {
    const authorized = await (config.refunds?.authorize?.(input) ?? false);
    if (authorized !== true) {
      throw createBillFnError({
        code: 'BILLFN_UNAUTHORIZED',
        message: 'Refunds through the BillFn router are not authorized'
      });
    }
  };
  const ensureInternalTokenPresented = async (request: Request) => {
    const expected = config.region?.internalToken;
    const presented = readBearerToken(request);
    if (!expected || !presented || !(await tokensMatch(presented, expected))) {
      throw createBillFnError({
        code: 'BILLFN_UNAUTHENTICATED',
        message: 'A valid internal token is required'
      });
    }
  };
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/status',
      handler: async () =>
        successResponse({
          ok: true,
          version: 1,
          namespace: service.namespace,
          providers: Object.keys(config.providers ?? {}),
          capabilities: [
            'catalog.read',
            'checkout.create',
            'checkout.verify',
            'subscription.cancel',
            'subscription.change',
            'subscription.resume',
            'subscription.refund',
            'subscription.sync',
            'purchase.restore',
            'entitlements.read',
            'usage.read',
            'webhook.ingest',
            'ops.reconciliation'
          ]
        })
    },
    {
      method: 'GET',
      path: '/catalog',
      handler: async () => successResponse(await service.getCatalog())
    },
    {
      method: 'GET',
      path: '/entitlements',
      handler: async (request) => {
        const subject = await resolveRequestSubject(request, config.auth);
        const response = await service.getEntitlements(subject);
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'GET',
      path: '/usage',
      handler: async (request, context) => {
        const subject = await resolveRequestSubject(request, config.auth);
        const resource = context.query.get('resource') ?? undefined;
        const response = await service.getUsage(subject, resource);
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/checkouts',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          planKey: string;
          provider: string;
          interval?: string;
          priceId?: unknown;
          metadata?: Record<string, unknown>;
          customer?: {
            email?: string;
            name?: string;
            billing?: Record<string, unknown>;
          };
          returnUrl?: string;
          successUrl?: string;
          cancelUrl?: string;
        }>(request);
        // The request's metadata is unchecked JSON; the check itself narrows it to the type the service takes.
        const metadata: unknown = body.metadata;
        assertCheckoutMetadata(metadata);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.createCheckout({
          subject,
          planKey: body.planKey,
          provider: body.provider as never,
          interval: body.interval as never,
          priceId: body.priceId as string | undefined,
          metadata,
          customer: body.customer,
          returnUrl: body.returnUrl,
          successUrl: body.successUrl,
          cancelUrl: body.cancelUrl
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data, 201);
      }
    },
    {
      method: 'POST',
      path: '/checkouts/verify',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          checkoutSessionId: string;
          payload?: Record<string, unknown>;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.verifyCheckout({
          subject,
          checkoutSessionId: body.checkoutSessionId,
          payload: body.payload
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/subscriptions/cancel',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          subscriptionId?: string;
          reason?: string;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.cancelSubscription({
          subject,
          subscriptionId: body.subscriptionId,
          reason: body.reason
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/subscriptions/change',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          subscriptionId?: string;
          targetPriceId: string;
          effectiveAt?: 'immediate' | 'next_renewal';
          prorationBehavior?: 'provider_default' | 'prorate' | 'none';
          reason?: string;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.changeSubscription({
          subject,
          subscriptionId: body.subscriptionId,
          targetPriceId: body.targetPriceId,
          effectiveAt: body.effectiveAt,
          prorationBehavior: body.prorationBehavior,
          reason: body.reason
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/subscriptions/resume',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          subscriptionId?: string;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.resumeSubscription({
          subject,
          subscriptionId: body.subscriptionId
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/subscriptions/refund',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          subscriptionId?: string;
          providerChargeId?: string;
          mode?: 'full' | 'prorated_remaining_period' | 'custom';
          amount?: number;
          reason?: string;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.refundCharge(
          {
            subject,
            subscriptionId: body.subscriptionId,
            providerChargeId: body.providerChargeId,
            mode: body.mode,
            amount: body.amount,
            reason: body.reason
          },
          { authorize: (target) => ensureRefundAuthorized({ request, ...target }) }
        );
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/subscriptions/sync',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          subscriptionId?: string;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.syncSubscription({
          subject,
          subscriptionId: body.subscriptionId
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/purchases/restore',
      handler: async (request) => {
        const body = await parseJsonBody<{
          subject?: BillableSubject;
          planKey: string;
          provider: string;
          priceId?: string;
          purchaseReference: string;
          payload?: Record<string, unknown>;
        }>(request);
        const subject = await resolveRequestSubject(request, config.auth, body.subject);
        const response = await service.restorePurchases({
          subject,
          planKey: body.planKey,
          provider: body.provider as never,
          priceId: body.priceId,
          purchaseReference: body.purchaseReference,
          payload: body.payload
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/webhooks/:provider',
      handler: async (request, context) => {
        const rawBody = await readBoundedText(request);
        const response = await service.handleWebhook({
          provider: context.params.provider as never,
          rawBody,
          headers: request.headers
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'GET',
      path: '/ops/owner',
      handler: async (request, context) => {
        await ensureInternalTokenPresented(request);
        const provider = context.query.get('provider') ?? '';
        const reference = context.query.get('ref') ?? '';
        if (!PROVIDER_NAMES.has(provider) || !reference || reference.length > MAX_PROVIDER_REFERENCE_LENGTH) {
          throw createBillFnError({
            code: 'BILLFN_VALIDATION_ERROR',
            message: 'provider must name a billing provider and ref a provider reference'
          });
        }
        const owned = await service.ownsProviderReference(provider as BillingProviderName, reference);
        return successResponse({ owned });
      }
    },
    {
      method: 'POST',
      path: '/ops/reconciliation/jobs',
      handler: async (request) => {
        await ensureOperationsAuthorized(request);
        const body = await parseJsonBody<{
          kind: BillFnReconciliationJobKind;
          provider?: string;
          billingAccountId?: string;
          subscriptionId?: string;
          providerEventId?: string;
          cursor?: string;
          payload?: Record<string, unknown>;
        }>(request);
        const response = await service.enqueueReconciliationJob({
          kind: body.kind,
          provider: body.provider as never,
          billingAccountId: body.billingAccountId,
          subscriptionId: body.subscriptionId,
          providerEventId: body.providerEventId,
          cursor: body.cursor,
          payload: body.payload
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data, 201);
      }
    },
    {
      method: 'GET',
      path: '/ops/reconciliation/jobs/:jobId',
      handler: async (request, context) => {
        await ensureOperationsAuthorized(request);
        const response = await service.getReconciliationJob({
          jobId: context.params.jobId
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    },
    {
      method: 'POST',
      path: '/ops/reconciliation/jobs/:jobId/run',
      handler: async (request, context) => {
        await ensureOperationsAuthorized(request);
        const response = await service.runReconciliationJob({
          jobId: context.params.jobId
        });
        if (!response.ok) {
          return jsonResponse(response, response.error.status);
        }
        return successResponse(response.data);
      }
    }
  ];

  return createRouter({
    basePath: normalizeBasePath(config.basePath, '/billfn'),
    routes,
    onError: async (error) => errorResponse(error)
  });
}
