import { contentfnRequest, emptyResult } from "../contentfn/response.js";
export interface ImportOpsConfig { contentfnBaseUrl: string; headers?: NonNullable<RequestInit['headers']> }
export function contentfnImport(config: ImportOpsConfig, input: { dataset: string; artifact: unknown }) {
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/datasets/import", input, emptyResult, { headers: config.headers, maxResponseBytes: 64 * 1024, timeoutMs: 30_000, redirect: 'error' });
}
