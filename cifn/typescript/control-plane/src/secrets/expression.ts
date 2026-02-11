import type { SecFnClient } from './secfn-client.js';
import { interpolate } from '../expressions/interpolate.js';
import type { GithubContext } from '../expressions/types.js';

export interface ExpressionContext {
  secrets: SecFnClient;
  github?: GithubContext & { [key: string]: unknown };
}

/** Thin wrapper over expression interpolate; resolves ${{ github.* }} and ${{ secrets.* }}. */
export async function resolveExpressions(
  input: string,
  context: ExpressionContext,
): Promise<{ resolved: string; secretValues: string[] }> {
  const { result, secretValues } = await interpolate(input, {
    github: context.github,
    getSecret: (name: string) => context.secrets.getSecret(name),
  });
  return { resolved: result, secretValues };
}

export async function resolveEnvMap(
  env: Record<string, string>,
  context: ExpressionContext,
): Promise<{ resolved: Record<string, string>; secretValues: string[] }> {
  const resolved: Record<string, string> = {};
  const allSecretValues: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const result = await resolveExpressions(value, context);
    resolved[key] = result.resolved;
    allSecretValues.push(...result.secretValues);
  }

  return { resolved, secretValues: allSecretValues };
}
