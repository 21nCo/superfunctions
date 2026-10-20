import type { ControlPlaneStore } from '../store/store.js';
import { SecFnClient } from '../secrets/secfn-client.js';
import { generateRunnerSecret, hashSecret } from './crypto.js';

export async function registerRunner(
  store: ControlPlaneStore,
  secFn: SecFnClient,
  token: string,
  labels?: string[]
): Promise<{ ok: boolean; runnerId?: string; runnerSecret?: string; error?: string }> {
  const storedToken = await secFn.getSecret('CIFN_RUNNER_REGISTRATION_TOKEN');
  
  if (!storedToken || token !== storedToken) {
    return { ok: false, error: 'RUNNER_TOKEN_INVALID' };
  }

  const normalizedLabels = Array.isArray(labels) && labels.length > 0
    ? [...new Set(labels)]
    : ['default'];
  
  const runnerSecret = generateRunnerSecret();
  const secretHash = hashSecret(runnerSecret);
  const runner = await store.createRunner(normalizedLabels, secretHash);
  
  return { ok: true, runnerId: runner.id, runnerSecret };
}
