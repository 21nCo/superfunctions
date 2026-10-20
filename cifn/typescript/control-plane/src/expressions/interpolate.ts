/**
 * Single-pass ${{ ... }} interpolation. Supports github.*, secrets.*, hashFiles('...').
 * Interpolated values are strings. Clear error on unsupported expression.
 */

import { EXPR_MAX_LENGTH, type InterpolateContext } from './types.js';

const UNSUPPORTED_MSG = 'Unsupported expression in interpolation';

/** Extract expression from ${{ ... }} — inner trim. */
function extractExpression(s: string): string {
  const inner = s.slice(3, -2).trim();
  return inner;
}

/**
 * Interpolate a template string. Replaces ${{ expr }} with evaluated string values.
 * Single-pass; throws on unsupported expression.
 */
export async function interpolate(
  template: string,
  context: InterpolateContext,
): Promise<{ result: string; secretValues: string[] }> {
  const secretValues: string[] = [];
  const re = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
  const chunks: string[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;

  re.lastIndex = 0;
  while ((match = re.exec(template)) !== null) {
    const full = match[0];
    const inner = extractExpression(full);
    const len = Buffer.byteLength(inner, 'utf8');
    if (len > EXPR_MAX_LENGTH) {
      throw new Error(`Expression exceeds maximum length of ${EXPR_MAX_LENGTH} characters (actual: ${len})`);
    }
    const value = await resolveInterpolationExpression(inner, context, secretValues);
    chunks.push(template.slice(offset, match.index), value);
    offset = match.index + full.length;
  }

  chunks.push(template.slice(offset));
  return { result: chunks.join(''), secretValues };
}

async function resolveInterpolationExpression(
  expr: string,
  context: InterpolateContext,
  secretValues: string[],
): Promise<string> {
  const t = expr.trim();

  // hashFiles('glob')
  const hashFilesMatch = /^hashFiles\s*\(\s*'([^']*)'\s*\)$/.exec(t);
  if (hashFilesMatch) {
    const glob = hashFilesMatch[1];
    const hashFilesFn = context.hashFiles;
    const workspaceRoot = context.workspaceRoot ?? '';
    if (!hashFilesFn) {
      throw new Error(`${UNSUPPORTED_MSG}: hashFiles requires workspaceRoot and hashFiles in context`);
    }
    return Promise.resolve(hashFilesFn(glob));
  }

  // github.*
  if (t.startsWith('github.')) {
    const key = t.slice(7).trim();
    const allowed = ['ref', 'repository', 'sha', 'event_name'];
    if (!allowed.includes(key)) throw new Error(`${UNSUPPORTED_MSG}: github.${key}`);
    const v = context.github?.[key as keyof NonNullable<InterpolateContext['github']>];
    return typeof v === 'string' ? v : '';
  }

  // secrets.*
  if (t.startsWith('secrets.')) {
    const name = t.slice(8).trim();
    const getSecret = context.getSecret;
    if (!getSecret) throw new Error(`${UNSUPPORTED_MSG}: secrets require getSecret in context`);
    const v = await getSecret(name);
    if (v !== null) secretValues.push(v);
    return v ?? '';
  }

  throw new Error(`${UNSUPPORTED_MSG}: ${t}`);
}

/**
 * Interpolate a template synchronously when no async context (secrets/hashFiles) is needed.
 * Only github.* is resolved; secrets and hashFiles throw.
 */
export function interpolateSync(
  template: string,
  context: Pick<InterpolateContext, 'github'>,
): { result: string; secretValues: string[] } {
  const secretValues: string[] = [];
  const re = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
  const chunks: string[] = [];
  let offset = 0;
  let match: RegExpExecArray | null;

  re.lastIndex = 0;
  while ((match = re.exec(template)) !== null) {
    const full = match[0];
    const inner = extractExpression(full).trim();
    if (inner.startsWith('github.')) {
      const key = inner.slice(7).trim();
      const allowed = ['ref', 'repository', 'sha', 'event_name'];
      if (!allowed.includes(key)) throw new Error(`${UNSUPPORTED_MSG}: github.${key}`);
      const v = context.github?.[key as keyof NonNullable<InterpolateContext['github']>];
      chunks.push(template.slice(offset, match.index), typeof v === 'string' ? v : '');
      offset = match.index + full.length;
    } else {
      throw new Error(`${UNSUPPORTED_MSG}: ${inner} (use async interpolate for secrets/hashFiles)`);
    }
  }

  chunks.push(template.slice(offset));
  return { result: chunks.join(''), secretValues };
}
