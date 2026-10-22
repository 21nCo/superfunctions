/** ContentFn HTTP document projection; the transport dependency is validated at runtime. */
import { contentfnRequest, emptyResult, isRecord } from "../contentfn/response.js";

export interface ContentfnClientConfig { baseUrl: string }
export interface ContentfnDocument extends Record<string, unknown> {
  _id: string;
  _type: string;
}
function documentResult(value: unknown, expectedId: string): ContentfnDocument | null {
  if (!isRecord(value) || value._id !== expectedId || typeof value._type !== "string" || !value._type) return null;
  if (value._rev !== undefined && typeof value._rev !== "string") return null;
  if (value._cms !== undefined && (!isRecord(value._cms) ||
      (value._cms.state !== undefined && typeof value._cms.state !== "string"))) return null;
  return { ...value, _id: value._id, _type: value._type };
}
export function getDraftDoc(config: ContentfnClientConfig, dataset: string, id: string) {
  const draftId = id.startsWith("drafts.") ? id : `drafts.${id}`;
  return contentfnRequest(config.baseUrl, "/contentfn/docs/get", { dataset, id: draftId, perspective: "draft" }, value => documentResult(value, draftId));
}
export function contentfnPublish(config: ContentfnClientConfig, dataset: string, id: string, ifRev?: string) {
  return contentfnRequest(config.baseUrl, "/contentfn/docs/publish", { dataset, id, ...(ifRev ? { ifRev } : {}) }, value => documentResult(value, id.startsWith("drafts.") ? id.substring(7) : id));
}
export function contentfnUnpublish(config: ContentfnClientConfig, dataset: string, id: string) {
  return contentfnRequest(config.baseUrl, "/contentfn/docs/unpublish", { dataset, id: id.startsWith("drafts.") ? id.substring(7) : id }, emptyResult);
}
