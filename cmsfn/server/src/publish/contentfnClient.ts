/** ContentFn HTTP document projection; the transport dependency is validated at runtime. */
import { contentfnRequest, emptyResult, isRecord, type ContentfnRequestOptions } from "../contentfn/response.js";

export interface ContentfnClientConfig extends ContentfnRequestOptions { baseUrl: string }
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
  return contentfnRequest(config.baseUrl, "/contentfn/docs/get", { dataset, id: draftId, perspective: "draft" }, value => {
    const document = documentResult(value, draftId);
    // Publishing must compare the exact revision whose workflow and type were checked.
    if (!document || typeof document._rev !== "string" || !document._rev.trim()) return null;
    const checked: ContentfnDocument & { _rev: string } = { ...document, _rev: document._rev };
    return checked;
  }, config);
}
export function contentfnPublish(config: ContentfnClientConfig, dataset: string, id: string, ifRev?: string) {
  return contentfnRequest(config.baseUrl, "/contentfn/docs/publish", { dataset, id, ...(ifRev ? { ifRev } : {}) }, value => documentResult(value, id.startsWith("drafts.") ? id.substring(7) : id), config);
}
export function contentfnUnpublish(config: ContentfnClientConfig, dataset: string, id: string) {
  return contentfnRequest(config.baseUrl, "/contentfn/docs/unpublish", { dataset, id: id.startsWith("drafts.") ? id.substring(7) : id }, emptyResult);
}
