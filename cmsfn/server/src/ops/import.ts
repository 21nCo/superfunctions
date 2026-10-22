import { contentfnRequest, emptyResult } from "../contentfn/response.js";
export interface ImportOpsConfig { contentfnBaseUrl: string }
export function contentfnImport(config: ImportOpsConfig, input: { dataset: string; artifact: unknown }) {
  return contentfnRequest(config.contentfnBaseUrl, "/contentfn/datasets/import", input, emptyResult);
}
