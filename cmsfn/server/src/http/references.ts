/** Server-authorized, published-only reference candidates. */
import type { IncomingMessage } from 'http';
import { err, evaluatePermissions, parseReferenceInput, projectReferencePage, referenceQuery, type CmsfnReferencePage, type CmsfnEnvelope } from 'cmsfn';
import { type AuthorizeConfig } from '../auth/authorize.js';
import type { CapabilityGateConfig } from '../contentfn/statusClient.js';
import { contentfnRequest } from '../contentfn/response.js';
import { readJsonObject } from './jsonBody.js';
export interface ReferenceHandlerConfig extends AuthorizeConfig, CapabilityGateConfig {
  allowedDatasets: readonly string[]; contentfnBaseUrl: string;
  contentfnReferenceHeaders?: (request: IncomingMessage) => NonNullable<RequestInit['headers']> | Promise<NonNullable<RequestInit['headers']>>;
}
export async function handleReferenceQuery(config: ReferenceHandlerConfig, request: IncomingMessage): Promise<CmsfnEnvelope<CmsfnReferencePage>> {
  const body = await readJsonObject(request, 96 * 1024); if (!body.ok) return body;
  const input = parseReferenceInput(body.result); if (!input) return err('VALIDATION_FAILED', 'Invalid reference query');
  try {
    if (!config.allowedDatasets.includes(input.dataset)) return err('PERMISSION_DENIED', 'No access to references.');
    const roles = await config.getRolesForSubject?.(request);
    if (!roles) return err('PERMISSION_DENIED', 'No access to references.');
    for (const type of input.types) if (!evaluatePermissions(roles, { dataset: input.dataset, type, action: 'doc.read' })) return err('PERMISSION_DENIED', 'No access to references.');
  } catch { return err('PERMISSION_DENIED', 'No access to references.'); }
  try {
    if (config.checkCapabilities && !await config.checkCapabilities(request, ['content.docs'])) return err('CONTENTFN_UNAVAILABLE', 'Reference queries are unavailable.');
    const headers = await config.contentfnReferenceHeaders?.(request);
    const query = referenceQuery(input);
    const deadline = Date.now() + 10_000;
    for (let limit = input.limit ?? 20;; limit = Math.max(1, Math.floor(limit / 2))) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remaining = Math.max(1, deadline - Date.now());
      const response = await Promise.race([
        contentfnRequest(config.contentfnBaseUrl, '/contentfn/query', { ...query, limit }, value => projectReferencePage(value, { ...input, limit }), { headers, maxResponseBytes: 2 * 1024 * 1024, timeoutMs: remaining, redirect: 'error', denyOnHttpAuthStatus: true }),
        new Promise<CmsfnEnvelope<CmsfnReferencePage>>(resolve => { timer = setTimeout(() => resolve(err('CONTENTFN_UNAVAILABLE', 'Reference query timed out.')), remaining); }),
      ]).finally(() => clearTimeout(timer));
      if (response.ok) return response;
      if (response.error.details.failureKind === 'response-too-large' && limit > 1 && Date.now() < deadline) continue;
      return err(response.error.code, response.error.code === 'PERMISSION_DENIED' || response.error.code === 'AUTH_REQUIRED' ? 'No access to references.' : 'Reference query could not be completed.', response.error.details.failureKind === 'response-too-large' ? { reason: 'REFERENCE_PREVIEW_TOO_LARGE' } : {});
    }
  } catch { return err('CONTENTFN_UNAVAILABLE', 'Reference query could not be configured.'); }
}
