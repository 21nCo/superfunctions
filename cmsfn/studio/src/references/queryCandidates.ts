/** CMS authorization is required unless the host explicitly delegates policy to ContentFn. */
import { parseReferenceInput, parseReferencePage, projectReferencePage, referenceQuery, type CmsfnReferencePage } from 'cmsfn';
import type { ContentfnEnvelope, CfqlProjection } from '@contentfn/core';
import { boundedRequest } from '../contentfn/boundedRequest.js';
export interface QueryCandidatesParams {
  baseUrl: string; cmsfnApiUrl?: string; dataset: string; types: string[];
  /** Standalone hosts explicitly enforce dataset/type read policy on ContentFn query. */
  allowContentfnAuthorization?: boolean;
  projection?: CfqlProjection; limit?: number; cursor?: string | null; search?: string; signal?: AbortSignal;
}
export async function queryCandidates(params: QueryCandidatesParams): Promise<ContentfnEnvelope<CmsfnReferencePage>> {
  const input = parseReferenceInput(params);
  if (!input) return { ok: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid reference query.', details: {} } };
  if (!params.cmsfnApiUrl && !params.allowContentfnAuthorization) return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'Reference authorization is not configured.', details: {} } };
  if (params.cmsfnApiUrl) {
    const result = await boundedRequest(params.cmsfnApiUrl, '/cmsfn/references/query', input, (value): value is CmsfnReferencePage => parseReferencePage(value, input) !== null, params.signal, 'references');
    if (!result.ok) return result;
    const page = parseReferencePage(result.result, input);
    return page ? { ok: true, result: page } : { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Invalid reference response.', details: {} } };
  }
  // This explicit mode uses the producer query authorization directly, never a UI boolean.
  const deadline = Date.now() + 10_000;
  for (let limit = input.limit ?? 20;; limit = Math.max(1, Math.floor(limit / 2))) {
    const scoped = { ...input, limit };
    const result = await boundedRequest(params.baseUrl, '/contentfn/query', referenceQuery(scoped), (value): value is { data: unknown[]; nextCursor: string | null } => projectReferencePage(value, scoped) !== null, params.signal, 'references', Math.max(1, deadline - Date.now()));
    if (!result.ok) {
      if (result.error.details.reason === 'RESPONSE_TOO_LARGE' && limit > 1 && Date.now() < deadline && !params.signal?.aborted) continue;
      return result;
    }
    const projected = projectReferencePage(result.result, scoped);
    return projected ? { ok: true, result: projected } : { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Invalid reference response.', details: {} } };
  }
}
