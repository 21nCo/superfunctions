import { snapshotForkApprovals, type ForkApproval } from './fork-approval.js';
import { discoverSecrets } from '../secrets/discover.js';
import { normalizeGitHubEvent } from './github-event.js';
import { prepareRun, acceptRun } from '../dispatch/prepare.js';
import type { ControlPlaneStore } from '../store/store.js';
import { verifyWebhookSignature } from '@superfunctions/webhooks';
import type { TriggerType } from '../pipeline/types.js';
import type { CreateRunInput } from '../store/memory-store.js';
import type { QueueClient } from '../queue/flowfn-client.js';
import { validate } from '../pipeline/validator.js';
import { parse, normalizeParsedPipeline } from '../pipeline/parser.js';
import { ResolverError, type PipelineRef } from '../pipeline/resolver.js';
import type { SecFnClient } from '../secrets/secfn-client.js';

export type PipelineDocResolver = (ref: PipelineRef) => Promise<{ doc: string; resolvedConfigPath: string }>;

export interface WebhookOptions {
  store: ControlPlaneStore;
  queue: QueueClient;
  webhookSecret: string;
  pipelineResolver?: PipelineDocResolver;
  secFn?: SecFnClient;
  forkApprovals?: readonly ForkApproval[];
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  return verifyWebhookSignature(payload, signature, secret, {
    algorithm: 'sha256',
    encoding: 'hex',
    prefix: 'sha256=',
  });
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export function parseGitHubEvent(eventType: string): TriggerType | null {
  if (eventType === 'push') return 'push';
  if (eventType === 'pull_request') return 'pull_request';
  return null;
}

export async function handleWebhook(
  rawBody: string,
  signature: string,
  eventType: string,
  options: WebhookOptions,
): Promise<WebhookResult> {
  if (!verifySignature(rawBody, signature, options.webhookSecret)) {
    return {
      status: 401,
      body: { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid webhook signature' } },
    };
  }

  const approvals = snapshotForkApprovals(options.forkApprovals);
  const triggerType = parseGitHubEvent(eventType);
  if (!triggerType) {
    return {
      status: 400,
      body: { ok: false, error: { code: 'BAD_REQUEST', message: `Unsupported event type: ${eventType}` } },
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
    };
  }

  let decision: ReturnType<typeof normalizeGitHubEvent>;
  try { decision = normalizeGitHubEvent(payload, triggerType as 'push' | 'pull_request', approvals); }
  catch {
    return { status: 400, body: { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid GitHub event identity' } } };
  }
  if (decision.kind === 'skip') return { status: 200, body: { ok: true, data: { skipped: true, reason: decision.reason } } };
  if (decision.kind === 'deny') return { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: decision.reason } } };
  const normalized = decision.event;
  const { repo, sha } = normalized;
  const pipelineRef: PipelineRef = normalized.configRef ?? { repo, ref: sha };

  if (!options.pipelineResolver) {
    return {
      status: 422,
      body: { ok: false, error: { code: 'RUN_CREATE_FAILED', message: 'Pipeline resolver not configured' } },
    };
  }

  let doc: string;
  let resolvedConfigPath: string;
  try {
    const result = await options.pipelineResolver(pipelineRef);
    doc = result.doc;
    resolvedConfigPath = result.resolvedConfigPath;
  } catch (err) {
    const message = err instanceof ResolverError ? err.message : 'Pipeline resolution failed';
    return {
      status: 422,
      body: { ok: false, error: { code: 'RUN_CREATE_FAILED', message } },
    };
  }

  let parsed: unknown;
  try {
    parsed = parse(doc);
  } catch {
    return {
      status: 422,
      body: { ok: false, error: { code: 'PIPELINE_INVALID', message: 'Pipeline document parse failed' } },
    };
  }

  const validationResult = validate(normalizeParsedPipeline(parsed));
  if (!validationResult.ok) {
    return {
      status: 422,
      body: { ok: false, error: { code: 'PIPELINE_INVALID', message: validationResult.message } },
    };
  }

  const trigger = validationResult.spec.on[triggerType as 'push' | 'pull_request'];
  if (!trigger || (trigger.branches !== undefined && !trigger.branches.includes(normalized.branch))) {
    return { status: 200, body: { ok: true, data: { skipped: true, reason: 'pipeline_trigger_filter' } } };
  }

  if (normalized.approval) {
    const allowed = new Set(normalized.approval.allowedSecrets);
    if ([...discoverSecrets(validationResult.spec)].some(name => !allowed.has(name))) return { status: 403, body: { ok: false, error: { code: 'FORBIDDEN', message: 'Fork pipeline secret access not authorized' } } };
  }
  const provenance = { configuration: { ...pipelineRef, configPath: resolvedConfigPath }, execution: { repo, ref: sha },
    ...(normalized.approval ? { forkApproval: { ...normalized.approval } } : {}) };
  const input: CreateRunInput = {
    pipelineSpec: validationResult.spec,
    pipelineRef: { repo, ref: sha, configPath: resolvedConfigPath },
    trigger: { type: triggerType, payload: { ...payload, github: normalized.github, cifnAdmission: provenance } },
  };

  const prepared = await prepareRun(input, options.secFn, normalized.github);
  const run = await acceptRun(options.store, options.queue, prepared);

  return {
    status: 201,
    body: { ok: true, data: { runId: run.id, status: run.status, createdAt: run.createdAt } },
  };
}
