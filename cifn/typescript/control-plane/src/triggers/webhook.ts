import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TriggerType } from '../pipeline/types.js';
import type { MemoryStore, CreateRunInput } from '../store/memory-store.js';
import type { QueueClient } from '../queue/flowfn-client.js';
import { DEFAULT_QUEUE_NAME } from '../queue/flowfn-client.js';
import { resolveDAG } from '../pipeline/dag.js';
import { validate } from '../pipeline/validator.js';
import { parse, normalizeParsedPipeline } from '../pipeline/parser.js';
import { ResolverError, type PipelineRef } from '../pipeline/resolver.js';
import { discoverSecrets } from '../secrets/discover.js';
import { resolveEnvMap } from '../secrets/expression.js';
import type { SecFnClient } from '../secrets/secfn-client.js';

export type PipelineDocResolver = (ref: PipelineRef) => Promise<{ doc: string; resolvedConfigPath: string }>;

export interface WebhookOptions {
  store: MemoryStore;
  queue: QueueClient;
  webhookSecret: string;
  pipelineResolver?: PipelineDocResolver;
  secFn?: SecFnClient;
}

export function verifySignature(payload: string, signature: string, secret: string): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const sig = signature.slice('sha256='.length);
  if (sig.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
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

  const repository = payload.repository as { clone_url?: string; full_name?: string } | undefined;
  const ref = payload.ref as string | undefined;

  if (!repository || !ref) {
    return {
      status: 400,
      body: { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing repository or ref in payload' } },
    };
  }

  const repo = repository.clone_url ?? repository.full_name ?? '';
  const refValue = ref.replace('refs/heads/', '');

  const pipelineRef: PipelineRef = { repo, ref: refValue };

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
    const message = err instanceof ResolverError ? err.message : (err instanceof Error ? err.message : 'Pipeline resolution failed');
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

  const input: CreateRunInput = {
    pipelineSpec: validationResult.spec,
    pipelineRef: { repo, ref: refValue, configPath: resolvedConfigPath },
    trigger: { type: triggerType, payload },
  };

  const run = options.store.createRun(input);

  const secretNames = discoverSecrets(validationResult.spec);
  const jobEnvMap: Record<string, Record<string, string>> = {};
  const jobSecretKeys: Record<string, string[]> = {};

  if (options.secFn) {
    for (const jobKey of Object.keys(validationResult.spec.jobs)) {
      const jobSpec = validationResult.spec.jobs[jobKey];
      const mergedEnv = { ...(validationResult.spec.env ?? {}), ...(jobSpec.env ?? {}) };
      
      const context = {
        secrets: options.secFn,
        github: {
          ref: ref,
          repository: repository.full_name ?? repo,
          sha: (payload.after as string) ?? '',
          event_name: triggerType,
        },
      };
      
      const { resolved, secretValues } = await resolveEnvMap(mergedEnv, context);
      jobEnvMap[jobKey] = resolved;
      jobSecretKeys[jobKey] = Array.from(secretNames);
      
      options.store.registerJobSecretValues(run.id, jobKey, secretValues);
    }
  }

  const dag = resolveDAG(validationResult.spec);
  for (const rootJobKey of dag.rootJobs) {
    const jobSpec = validationResult.spec.jobs[rootJobKey];
    await options.queue.enqueue(DEFAULT_QUEUE_NAME, {
      runId: run.id,
      jobKey: rootJobKey,
      jobSpec,
      pipelineRef: run.pipelineRef,
      env: jobEnvMap[rootJobKey],
      secretKeys: jobSecretKeys[rootJobKey],
    });
  }

  return {
    status: 201,
    body: { ok: true, data: { runId: run.id, status: run.status, createdAt: run.createdAt } },
  };
}
