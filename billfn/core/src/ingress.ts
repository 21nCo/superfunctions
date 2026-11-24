import { createBillFnError } from './errors.js';
import { errorResponse, readBoundedBytes } from './http.js';
import type { BillingProviderName } from './types.js';

/**
 * Provider metadata key naming the region whose BillFn owns the provider
 * record. Checkout writes it when `region` is configured; the ingress reads it.
 */
export const BILLFN_REGION_METADATA_KEY = 'billfn_region';

/** The largest webhook body the ingress reads, as the regions' routers do. */
const MAX_INGRESS_BODY_BYTES = 256 * 1024;

/** A region whose BillFn receives the events it owns. */
export interface BillFnIngressRegion {
  id: string;
  /**
   * The region's BillFn URL including the router base path, for example
   * `https://useast.example.com/billfn`. Events are forwarded to
   * `<url>/webhooks/<provider>` and owners are asked at `<url>/ops/owner`.
   */
  url: string;
}

/** What the ingress read from an event to route it, without verifying it. */
export interface BillFnIngressRoutingKeys {
  /** The provider record's `billfn_region` metadata value, when the payload carries one. */
  region?: string;
  /** Provider references the regions are asked about, most specific first. */
  references: string[];
}

export interface BillFnIngressResolveRegionInput {
  provider: BillingProviderName;
  keys: BillFnIngressRoutingKeys;
  headers: Headers;
  rawBody: string;
}

/**
 * How the region was chosen: the payload's `billfn_region` metadata, the
 * host's `resolveRegion`, a region's owner lookup, or the default region.
 * `unavailable` means ownership could not be established (a region's owner
 * lookup did not answer and none claimed the event, or `resolveRegion` threw):
 * the event is forwarded nowhere and the provider is asked to retry (503).
 */
export type BillFnIngressRoute = 'metadata' | 'resolver' | 'owner-lookup' | 'default' | 'unavailable';

export type BillFnIngressRouteDecision = {
  provider: BillingProviderName;
  /** Regions whose owner lookup failed, timed out or answered without a valid `{ owned }`. */
  unreachableRegions: string[];
} & (
  | { region: string; route: Exclude<BillFnIngressRoute, 'unavailable'> }
  | { region: null; route: 'unavailable' }
);

export interface BillFnWebhookIngressConfig {
  regions: BillFnIngressRegion[];
  /**
   * The region that receives events no region claims: deliveries without
   * routing references, or whose references every region answered it does not
   * own. It stores them as unlinked.
   */
  defaultRegion: string;
  /** The shared internal token every region's `region.internalToken` is set to. */
  internalToken: string;
  /**
   * Chooses the region for an event the `billfn_region` metadata does not
   * route, before the regions are asked. Return a configured region id, or
   * null or undefined to ask the regions' owner lookups. If it throws or
   * rejects, the delivery is forwarded nowhere and answered with a retryable 503.
   */
  resolveRegion?: (
    input: BillFnIngressResolveRegionInput
  ) => Promise<string | null | undefined> | string | null | undefined;
  /** Sends the forwarded request to its region. Defaults to `fetch`. */
  forward?: (request: Request, region: BillFnIngressRegion) => Promise<Response>;
  /** The `fetch` owner lookups (and the default `forward`) use. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * How long one region's owner lookup may take before it counts as
   * unreachable. Default 3000 ms. When a region is unreachable and no region
   * claims the event, the provider is asked to retry (503) rather than the
   * event going to the default region.
   */
  lookupTimeoutMs?: number;
  /** How long a forwarded delivery may take before the provider is asked to retry (503). Default 30000 ms. */
  forwardTimeoutMs?: number;
  /** Observes each routing decision, for logs and metrics. Errors it throws are ignored. */
  onRoute?: (decision: BillFnIngressRouteDecision) => void;
}

export interface BillFnWebhookIngress {
  /**
   * Routes one provider webhook delivery to its owning region and returns
   * that region's response. The body bytes and signature headers are
   * forwarded unchanged, so the destination verifies the signature.
   */
  handle(provider: BillingProviderName, request: Request): Promise<Response>;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 3_000;
const DEFAULT_FORWARD_TIMEOUT_MS = 30_000;
const MAX_REFERENCE_LENGTH = 512;
/**
 * Hop-by-hop and framing headers a proxy must not copy; the runtime sets them
 * for the new request. `expect` is dropped too: undici `fetch` rejects it.
 */
const UNFORWARDED_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

class TimeoutError extends Error {}

export function createWebhookIngress(config: BillFnWebhookIngressConfig): BillFnWebhookIngress {
  const regions = validateRegions(config);
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const fetchImpl = config.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const forward = config.forward ?? ((request: Request) => fetchImpl(request));
  const lookupTimeoutMs = config.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const forwardTimeoutMs = config.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;

  async function askOwner(
    region: BillFnIngressRegion,
    provider: BillingProviderName,
    reference: string
  ): Promise<boolean | null> {
    const url = `${region.url}/ops/owner?provider=${encodeURIComponent(provider)}&ref=${encodeURIComponent(reference)}`;
    const controller = new AbortController();
    try {
      return await withTimeout(lookupTimeoutMs, controller, async () => {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { authorization: `Bearer ${config.internalToken}` },
          signal: controller.signal
        });
        if (response.status !== 200) {
          return null;
        }
        const body = asRecord(await response.json());
        const owned = asRecord(body?.data)?.owned;
        return typeof owned === 'boolean' ? owned : null;
      });
    } catch {
      return null;
    }
  }

  async function lookUpOwner(provider: BillingProviderName, references: string[]) {
    const unreachable = new Set<string>();
    const answers = await Promise.all(
      references.map((reference) => Promise.all(regions.map((region) => askOwner(region, provider, reference))))
    );
    let owner: string | undefined;
    for (const perRegion of answers) {
      perRegion.forEach((owned, index) => {
        if (owned === null) {
          unreachable.add(regions[index].id);
        }
      });
      const ownerIndex = perRegion.indexOf(true);
      if (owner === undefined && ownerIndex !== -1) {
        owner = regions[ownerIndex].id;
      }
    }
    return { owner, unreachableRegions: [...unreachable] };
  }

  async function route(
    provider: BillingProviderName,
    keys: BillFnIngressRoutingKeys,
    headers: Headers,
    rawBody: string
  ): Promise<BillFnIngressRouteDecision> {
    if (keys.region && regionsById.has(keys.region)) {
      return { provider, region: keys.region, route: 'metadata', unreachableRegions: [] };
    }
    if (config.resolveRegion) {
      let resolved: string | null | undefined;
      try {
        resolved = await config.resolveRegion({ provider, keys, headers, rawBody });
      } catch {
        return { provider, region: null, route: 'unavailable', unreachableRegions: [] };
      }
      if (resolved && regionsById.has(resolved)) {
        return { provider, region: resolved, route: 'resolver', unreachableRegions: [] };
      }
    }
    if (keys.references.length > 0) {
      const { owner, unreachableRegions } = await lookUpOwner(provider, keys.references);
      if (owner) {
        return { provider, region: owner, route: 'owner-lookup', unreachableRegions };
      }
      if (unreachableRegions.length > 0) {
        // An unanswered region may own the event: the default region would
        // acknowledge it as unlinked and the provider would stop retrying.
        return { provider, region: null, route: 'unavailable', unreachableRegions };
      }
      return { provider, region: config.defaultRegion, route: 'default', unreachableRegions };
    }
    return { provider, region: config.defaultRegion, route: 'default', unreachableRegions: [] };
  }

  async function forwardTo(
    region: BillFnIngressRegion,
    provider: BillingProviderName,
    request: Request,
    body: ArrayBuffer
  ): Promise<Response> {
    const target = new URL(`${region.url}/webhooks/${encodeURIComponent(provider)}`);
    target.search = new URL(request.url).search;
    const headers = new Headers();
    request.headers.forEach((value, name) => {
      if (!UNFORWARDED_HEADERS.has(name.toLowerCase())) {
        headers.set(name, value);
      }
    });
    const controller = new AbortController();
    const forwarded = new Request(target, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: controller.signal
    });
    try {
      return await withTimeout(forwardTimeoutMs, controller, () => forward(forwarded, region));
    } catch {
      return regionUnavailable('The owning region did not answer; retry the delivery');
    }
  }

  const tooLarge = () =>
    createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message: `Webhook body must be at most ${MAX_INGRESS_BODY_BYTES} bytes` });

  return {
    async handle(provider, request) {
      if (request.method !== 'POST') {
        return errorResponse(
          createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message: 'Webhooks are delivered with POST' })
        );
      }
      // Provider webhooks are a few kilobytes; a larger body is refused, without reading the rest of it, before any
      // owner lookup.
      let bytes: Awaited<ReturnType<typeof readBoundedBytes>>;
      try {
        bytes = await readBoundedBytes(request, MAX_INGRESS_BODY_BYTES);
      } catch {
        return errorResponse(
          createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message: 'The webhook body could not be read' })
        );
      }
      if (bytes === 'too_large') {
        return errorResponse(tooLarge());
      }
      if (bytes === 'already_read') {
        return errorResponse(
          createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message: 'The webhook body was already read before the ingress' })
        );
      }
      // The exact bytes received are forwarded, so the owning region verifies the provider's signature over them.
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const rawBody = new TextDecoder().decode(bytes);
      const keys = readRoutingKeys(provider, rawBody);
      const decision = await route(provider, keys, request.headers, rawBody);
      try {
        config.onRoute?.(decision);
      } catch {
        // Observation never changes routing.
      }
      if (decision.region === null) {
        return regionUnavailable('The owning region could not be determined; retry the delivery');
      }
      return forwardTo(regionsById.get(decision.region) as BillFnIngressRegion, provider, request, body);
    }
  };
}

/**
 * Reads the routing keys of a delivery without verifying it: Dodo's
 * `data.metadata.billfn_region` and its subscription and payment ids, and the
 * original and current transaction ids of an Apple notification's (unverified)
 * signed transaction. Anything unreadable yields no keys.
 */
export function readRoutingKeys(provider: BillingProviderName, rawBody: string): BillFnIngressRoutingKeys {
  const payload = parseJsonRecord(rawBody);
  if (!payload) {
    return { references: [] };
  }
  if (provider === 'dodo') {
    const data = asRecord(payload.data) ?? payload;
    const metadata = asRecord(data.metadata);
    return {
      region: readString(metadata, BILLFN_REGION_METADATA_KEY),
      references: references(readString(data, 'subscription_id'), readString(data, 'payment_id'))
    };
  }
  if (provider === 'apple') {
    const notification = decodeJwsPayload(readString(payload, 'signedPayload'));
    const data = asRecord(notification?.data);
    const transaction = decodeJwsPayload(readString(data, 'signedTransactionInfo'));
    const renewal = decodeJwsPayload(readString(data, 'signedRenewalInfo'));
    return {
      references: references(
        readString(transaction, 'originalTransactionId') ?? readString(renewal, 'originalTransactionId'),
        readString(transaction, 'transactionId')
      )
    };
  }
  return { references: [] };
}

function validateRegions(config: BillFnWebhookIngressConfig): BillFnIngressRegion[] {
  const invalid = (message: string) => createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message });
  if (!Array.isArray(config.regions) || config.regions.length === 0) {
    throw invalid('createWebhookIngress requires at least one region');
  }
  const seen = new Set<string>();
  const regions = config.regions.map((region) => {
    if (!region.id || seen.has(region.id)) {
      throw invalid('Every ingress region needs a unique id');
    }
    seen.add(region.id);
    let url: URL;
    try {
      url = new URL(region.url);
    } catch {
      throw invalid(`Ingress region ${region.id} needs an absolute url`);
    }
    if (url.search || url.hash) {
      throw invalid(`Ingress region ${region.id} url must not carry a query or fragment`);
    }
    return { id: region.id, url: trimTrailingSlashes(region.url) };
  });
  if (!seen.has(config.defaultRegion)) {
    throw invalid('createWebhookIngress defaultRegion must name a configured region');
  }
  if (!config.internalToken) {
    throw invalid('createWebhookIngress requires the shared internal token');
  }
  return regions;
}

function regionUnavailable(message: string): Response {
  return errorResponse(createBillFnError({ code: 'BILLFN_REGION_UNAVAILABLE', message }));
}

/** Drops trailing `/` characters in one linear pass (no backtracking regex). */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(0, end);
}

async function withTimeout<T>(ms: number, controller: AbortController, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`Timed out after ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function references(...values: Array<string | undefined>): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (value && value.length <= MAX_REFERENCE_LENGTH && !unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/** The payload of a compact JWS, decoded without verifying its signature. */
function decodeJwsPayload(token: string | undefined): Record<string, unknown> | null {
  const segment = token?.split('.')[1];
  if (!segment) {
    return null;
  }
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    return parseJsonRecord(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readString(record: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
