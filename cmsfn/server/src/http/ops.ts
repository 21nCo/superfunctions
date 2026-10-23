/** Authorized synchronous import/export. Cross-dataset migration requires explicit server policy. */
import type { IncomingMessage } from 'http';
import { err, type CmsfnEnvelope } from 'cmsfn';
import { authorize, type AuthorizeConfig } from '../auth/authorize.js';
import { contentfnExport, isExportArtifact } from '../ops/export.js';
import { contentfnImport } from '../ops/import.js';
import { readJsonObject } from './jsonBody.js';
export const OPS_BODY_MAX_BYTES = 25 * 1024 * 1024;
export interface OpsHandlerConfig extends AuthorizeConfig {
  contentfnBaseUrl: string;
  allowedDatasets: string[];
  authorizeOps?: (req: IncomingMessage) => Promise<boolean>;
  contentfnOpsHeaders?: (req: IncomingMessage) => NonNullable<RequestInit['headers']> | Promise<NonNullable<RequestInit['headers']>>;
  authorizeCrossDatasetImport?: (req: IncomingMessage, input: { sourceDataset: string; targetDataset: string }) => Promise<boolean>;
}
async function input(config: OpsHandlerConfig, req: IncomingMessage, maxBytes: number): Promise<CmsfnEnvelope<Record<string, unknown>>> {
  try {
    if (!config.getRolesForSubject || config.authorizeOps && await config.authorizeOps(req) !== true) return err('PERMISSION_DENIED', 'Permission denied');
  } catch { return err('PERMISSION_DENIED', 'Permission denied'); }
  const parsed = await readJsonObject(req, maxBytes); if (!parsed.ok) return parsed;
  const dataset = typeof parsed.result.dataset === 'string' ? parsed.result.dataset.trim() : '';
  if (!dataset || !config.allowedDatasets.includes(dataset)) return err('VALIDATION_FAILED', 'Dataset not allowed', { path: 'dataset' });
  try { if (!await authorize(config, req, { dataset, type: '*', action: 'audit.read' })) return err('PERMISSION_DENIED', 'Permission denied'); }
  catch { return err('PERMISSION_DENIED', 'Permission denied'); }
  return { ok: true, result: { ...parsed.result, dataset } };
}
export async function handleOpsExport(config: OpsHandlerConfig, req: IncomingMessage): Promise<CmsfnEnvelope<{ artifact: unknown }>> {
  const parsed = await input(config, req, 64 * 1024); if (!parsed.ok) return parsed;
  try {
    const headers = await config.contentfnOpsHeaders?.(req);
    return await contentfnExport({ contentfnBaseUrl: config.contentfnBaseUrl, headers }, String(parsed.result.dataset));
  } catch { return err('CONTENTFN_UNAVAILABLE', 'ContentFn export request could not be configured'); }
}
export async function handleOpsImport(config: OpsHandlerConfig, req: IncomingMessage): Promise<CmsfnEnvelope<Record<string, never>>> {
  const parsed = await input(config, req, OPS_BODY_MAX_BYTES); if (!parsed.ok) return parsed;
  const dataset = String(parsed.result.dataset), artifact = parsed.result.artifact;
  if (!isExportArtifact(artifact)) return err('VALIDATION_FAILED', 'Malformed import artifact', { path: 'artifact' });
  if (artifact.dataset !== dataset) {
    try { if (!config.authorizeCrossDatasetImport || await config.authorizeCrossDatasetImport(req, { sourceDataset: artifact.dataset, targetDataset: dataset }) !== true) return err('PERMISSION_DENIED', 'Cross-dataset import denied'); }
    catch { return err('PERMISSION_DENIED', 'Cross-dataset import denied'); }
  }
  try {
    const headers = await config.contentfnOpsHeaders?.(req);
    return await contentfnImport({ contentfnBaseUrl: config.contentfnBaseUrl, headers }, { dataset, artifact });
  } catch { return err('CONTENTFN_UNAVAILABLE', 'ContentFn import request could not be configured'); }
}
