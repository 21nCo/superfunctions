import { CronScheduler, parseCronPipelines } from './triggers/cron.js';
import { snapshotForkApprovals } from './triggers/fork-approval.js';
import { resolvePipelineDoc } from './pipeline/resolver.js';
import { LogFnStepOutputDispatcher } from './observability/step-output.js';
import { sinkConsole } from '@logfn/core';
import { LogFnLifecycleDispatcher } from './observability/dispatcher.js';
import type { DatabaseStore } from "./store/database-store.js";
import { createControlPlaneServer } from './http-server.js';
import { createApp } from './api/routes.js';
import { parseAdapterConfig, validateAdapterConfig } from './integrations/config.js';
import { createQueueAdapter } from './integrations/flowfn.js';
import { createArtifactsAdapter } from './integrations/filefn.js';
import { createSecretsAdapter } from './integrations/secfn.js';
import { createLogsAdapter } from './integrations/logfn.js';
import { createRuntimeStore } from './store/runtime-store.js';

const PORT = parseInt(process.env.PORT ?? '3100', 10);

const requiredEnv: Record<string, string | undefined> = {
  CIFN_RUNNER_REGISTRATION_TOKEN: process.env.CIFN_RUNNER_REGISTRATION_TOKEN,
};

for (const [name, value] of Object.entries(requiredEnv)) {
  if (!value) {
    console.error(`Fatal: missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const adapterConfig = parseAdapterConfig(process.env);
const validation = validateAdapterConfig(adapterConfig);
if (!validation.ok) {
  for (const err of validation.errors) {
    console.error(`Fatal: ${err}`);
  }
  process.exit(1);
}

const adapters = {
  queue: createQueueAdapter(adapterConfig.queue),
  artifacts: createArtifactsAdapter(adapterConfig.artifacts),
  secrets: createSecretsAdapter(adapterConfig.secrets),
  logs: createLogsAdapter(adapterConfig.logs),
};

async function start() {
  const initialApiKeys = process.env.CIFN_API_KEYS;
  if (initialApiKeys && adapterConfig.secrets.type === 'memory') {
    await adapters.secrets.setSecret('CIFN_API_KEYS', initialApiKeys);
  }

  const registrationToken = process.env.CIFN_RUNNER_REGISTRATION_TOKEN!;
  if (adapterConfig.secrets.type === 'memory') {
    await adapters.secrets.setSecret('CIFN_RUNNER_REGISTRATION_TOKEN', registrationToken);
  }

  if (adapterConfig.secrets.type === 'memory' && process.env.CIFN_GIT_TOKEN) await adapters.secrets.setSecret('CIFN_GIT_TOKEN', process.env.CIFN_GIT_TOKEN);

  const webhookSecret = process.env.CIFN_WEBHOOK_SECRET;

  const resolverMode = process.env.CIFN_PIPELINE_RESOLVER ?? 'off';
  if (!['off', 'git'].includes(resolverMode)) throw new Error('CIFN_PIPELINE_RESOLVER must be off or git');
  const localRepositories = process.env.CIFN_ALLOW_LOCAL_REPOSITORIES ?? 'false';
  if (!['true', 'false'].includes(localRepositories)) throw new Error('CIFN_ALLOW_LOCAL_REPOSITORIES must be true or false');
  const forkPolicy = process.env.CIFN_FORK_APPROVALS;
  if (forkPolicy && Buffer.byteLength(forkPolicy, 'utf8') > 65536) throw new Error('Fork approval configuration exceeds limit');
  let forkApprovals;
  try { forkApprovals = snapshotForkApprovals(forkPolicy ? JSON.parse(forkPolicy) : undefined); }
  catch { throw new Error('Invalid fork approval configuration'); }
  const resolverAbort = new AbortController();
  const pipelineResolver = resolverMode === 'git' ? async (ref: import('./pipeline/resolver.js').PipelineRef) => {
    const token = await adapters.secrets.getSecret('CIFN_GIT_TOKEN');
    return resolvePipelineDoc(ref, { signal: resolverAbort.signal, token: token ?? undefined, allowLocalRepositories: localRepositories === 'true' });
  } : undefined;

  let closing = false;
  const lifecycleMode = process.env.CIFN_LIFECYCLE_LOGS ?? 'off';
  if (!['off', 'console'].includes(lifecycleMode)) throw new Error('CIFN_LIFECYCLE_LOGS must be off or console');
  if (lifecycleMode !== 'off' && process.env.CIFN_STORE_ADAPTER !== 'sqlite') throw new Error('Lifecycle LogFn delivery requires SQLite storage');
  const stepOutputMode = process.env.CIFN_STEP_OUTPUT_LOGS ?? 'off';
  if (!['off', 'console'].includes(stepOutputMode)) throw new Error('CIFN_STEP_OUTPUT_LOGS must be off or console');
  if (stepOutputMode !== 'off' && process.env.CIFN_STORE_ADAPTER !== 'sqlite') throw new Error('Step output LogFn delivery requires SQLite storage');
  const cronPipelines = parseCronPipelines(process.env.CIFN_CRON_PIPELINES);
  const runtimeStore = await createRuntimeStore();
  const cron = new CronScheduler({store:runtimeStore.store,queue:adapters.queue,secrets:adapters.secrets});
  try { for (const pipeline of cronPipelines) cron.register(pipeline); } catch { await runtimeStore.close(); throw new Error("Invalid cron pipeline registration"); }
  const stepOutput = stepOutputMode === 'console' ? new LogFnStepOutputDispatcher(runtimeStore.store as DatabaseStore, sinkConsole({ json: true, color: false })) : undefined;
  let stepOutputCursor: string | undefined;
  let stepOutputActive: Promise<unknown> | undefined;
  const deliverStepOutput = () => {
    if (!stepOutput || stepOutputActive || closing) return;
    stepOutputActive = stepOutput.tick(stepOutputCursor).then(page => { stepOutputCursor = page.nextCursor; })
      .catch(() => console.error('CiFn step output dispatch failed; inspect durable delivery state'))
      .finally(() => { stepOutputActive = undefined; });
  };
  const lifecycle = lifecycleMode === 'console' ? new LogFnLifecycleDispatcher(runtimeStore.store as DatabaseStore, sinkConsole({ json: true, color: false })) : undefined;
  let lifecycleCursor: string | undefined;
  let lifecycleActive: Promise<unknown> | undefined;
  const deliverLifecycle = () => {
    if (!lifecycle || lifecycleActive || closing) return;
    lifecycleActive = lifecycle.tick(lifecycleCursor).then(page => { lifecycleCursor = page.nextCursor; })
      .catch(() => console.error('CiFn lifecycle dispatch failed; inspect durable delivery state'))
      .finally(() => { lifecycleActive = undefined; });
  };
  const { app, dispatchPublisher, notificationPublisher } = createApp({ adapters, webhookSecret, store: runtimeStore.store, pipelineResolver, forkApprovals });

  const telemetry = runtimeStore.store as Partial<Pick<DatabaseStore, 'recordApiError'>>;
  const server = createControlPlaneServer(app, telemetry.recordApiError ? { recordApiError: event => telemetry.recordApiError!(event) } : undefined);
  const lifecycleTimer = setInterval(() => { deliverLifecycle(); deliverStepOutput(); }, 1000); lifecycleTimer.unref();
  let logCursor: string | undefined;
  let retentionActive: Promise<void> | undefined;
  const durableLogs = runtimeStore.store as Partial<Pick<DatabaseStore, 'purgeExpiredLogs'>>;
  const retain = () => {
    if (closing || retentionActive || !durableLogs.purgeExpiredLogs) return;
    retentionActive = durableLogs.purgeExpiredLogs(logCursor).then(page => { logCursor = page.nextCursor; })
      .catch(() => { console.error('CiFn log expiry cleanup failed; retry pending'); })
      .finally(() => { retentionActive = undefined; });
  };
  const retentionTimer = setInterval(retain, 60_000); retentionTimer.unref(); retain();
  const close = () => {
    if (closing) return;
    closing = true; resolverAbort.abort(); clearInterval(retentionTimer); clearInterval(lifecycleTimer);
    const cronClosing = cron.stop().catch(() => { console.error("CiFn cron shutdown failed; active ownership uncertain"); process.exitCode = 1; throw Error("Cron shutdown incomplete"); });
    void cronClosing.catch(() => {});
    const stepOutputClosing = stepOutput?.close().catch(() => { console.error('CiFn step output shutdown failed'); process.exitCode = 1; });
    const lifecycleClosing = lifecycle?.close().catch(() => { console.error('CiFn lifecycle shutdown failed'); process.exitCode = 1; });
    server.close(async () => {
      try { await dispatchPublisher?.stop(); }
      catch { console.error('CiFn dispatch shutdown failed'); process.exitCode = 1; }
      try { await notificationPublisher?.stop(); }
      catch { console.error('CiFn notification shutdown failed'); process.exitCode = 1; }
      await retentionActive;
      await lifecycleActive;
      await stepOutputActive;
      await stepOutputClosing;
      await lifecycleClosing;
      try { await cronClosing; } catch { return; }
      try { await runtimeStore.close(); }
      catch { console.error('CiFn store shutdown failed'); process.exitCode = 1; }
    });
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  server.once('error', () => {
    process.exitCode = 1; closing = true; resolverAbort.abort(); clearInterval(retentionTimer); clearInterval(lifecycleTimer);
    void Promise.all([cron.stop(), retentionActive, lifecycleActive, lifecycle?.close()]).then(() => runtimeStore.close()).catch(() => console.error('CiFn store shutdown failed'));
  });

  server.listen(PORT, () => {
    void cron.start().catch(() => { console.error("CiFn cron startup failed"); process.exitCode = 1; close(); });
    deliverLifecycle();
    dispatchPublisher?.start();
    notificationPublisher?.start();
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : PORT;
    console.log(`CiFn Control Plane listening on port ${listeningPort}`);
    console.log(`Store: ${runtimeStore.mode}`);
    console.log(`Adapters: queue=${adapterConfig.queue.type}, artifacts=${adapterConfig.artifacts.type}, secrets=${adapterConfig.secrets.type}, logs=${adapterConfig.logs.type}`);
  });
}
start().catch((cause: unknown) => {
  console.error(`Fatal: ${cause instanceof Error ? cause.message : "Control-plane startup failed"}`);
  process.exitCode = 1;
});
