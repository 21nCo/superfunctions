import type { PipelineSpec, JobSpec, StepSpec } from '../pipeline/types.js';

export function discoverSecrets(pipelineSpec: PipelineSpec): Set<string> {
  const secretNames = new Set<string>();
  
  if (pipelineSpec.env) {
    extractSecretsFromEnvMap(pipelineSpec.env, secretNames);
  }

  for (const jobKey of Object.keys(pipelineSpec.jobs)) {
    const jobSpec = pipelineSpec.jobs[jobKey];
    discoverJobSecrets(jobSpec, secretNames);
  }

  return secretNames;
}

function discoverJobSecrets(jobSpec: JobSpec, secretNames: Set<string>): void {
  if (jobSpec.if) {
    extractSecretsFromString(jobSpec.if, secretNames);
  }

  if (jobSpec.env) {
    extractSecretsFromEnvMap(jobSpec.env, secretNames);
  }

  for (const step of jobSpec.steps) {
    discoverStepSecrets(step, secretNames);
  }
}

function discoverStepSecrets(step: StepSpec, secretNames: Set<string>): void {
  if ('if' in step && step.if) {
    extractSecretsFromString(step.if, secretNames);
  }

  if ('run' in step && step.run) {
    extractSecretsFromString(step.run, secretNames);
  }

  if ('with' in step && step.with) {
    extractSecretsFromWithMap(step.with, secretNames);
  }
}

function extractSecretsFromEnvMap(env: Record<string, string>, secretNames: Set<string>): void {
  for (const value of Object.values(env)) {
    extractSecretsFromString(value, secretNames);
  }
}

function extractSecretsFromWithMap(withMap: Record<string, unknown>, secretNames: Set<string>): void {
  for (const value of Object.values(withMap)) {
    if (typeof value === 'string') {
      extractSecretsFromString(value, secretNames);
    }
  }
}

function extractSecretsFromString(str: string, secretNames: Set<string>): void {
  const re = /\$\{\{\s*secrets\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
  let match: RegExpExecArray | null;
  
  while ((match = re.exec(str)) !== null) {
    const secretName = match[1];
    secretNames.add(secretName);
  }
}
