import { insertAssetAtPath } from '../../media/insertAssetAtPath.js';
/**
 * Schema-driven document editor: load schema + doc, render widgets, save via patch with ifRev.
 * Handles VALIDATION_FAILED (field path) and REV_CONFLICT (ConflictBanner).
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ContentfnSchema, ContentfnDocument, ContentfnDocumentType } from "@contentfn/core";
import { getSchema, getDoc, patchDoc, forkDoc } from "../../contentfn/client.js";
import { buildPatchOps } from "../../editor/save/buildPatchOps.js";
import { checkRichtextLimits } from "../../limits/precheck.js";
import { renderField } from "../../editor/renderField.js";
import { ConflictBanner } from "../../editor/conflicts/ConflictBanner.js";
import type { CmsfnWorkflowMetadata } from "cmsfn";
import { WorkflowControls } from "../../workflow/WorkflowControls.js";
import { PublishButton } from "../../publish/PublishButton.js";
import { PreviewPane } from "../preview/PreviewPane.js";
import { MediaLibraryPane } from "../media/MediaLibraryPane.js";
import type { CanonicalAssetRef } from "../../media/insertAssetRef.js";

export interface DocumentEditorPaneProps {
  baseUrl: string;
  dataset: string;
  docId: string;
  perspective?: "draft" | "published";
  /** Desk singleton type; mismatches must not expose editor controls. */
  expectedType?: string;
  onOpenDraft?: (id: string) => void;
  onUnpublished?: () => void;
  /** When set, Publish/Unpublish are shown and call CmsFn server. */
  cmsfnApiUrl?: string;
  /** Compatibility hint; configured publication controls verify current state through ContentFn. */
  isPublished?: boolean;
  /** When set, preview pane is shown (token + iframe). */
  previewConfig?: { enabled: boolean; targetOrigin: string; resolveUrl: (doc: unknown) => string };
  /** Optional ContentFn realtime WebSocket URL for live preview updates. */
  realtimeUrl?: string;
  /** Max upload bytes for media library (client pre-check). */
  maxUploadBytes?: number;
  allowContentfnReferenceAuthorization?: boolean;
  /** When true, show "remote changed" banner (TV-COLLAB-002). */
  remoteChanged?: boolean;
  /** Callback when user dismisses/refreshes after remote change. */
  onClearRemoteChanged?: () => void;
}

export function DocumentEditorPane({ baseUrl, dataset, docId, perspective = "draft", expectedType, onOpenDraft, onUnpublished, cmsfnApiUrl, isPublished, previewConfig, realtimeUrl, maxUploadBytes, allowContentfnReferenceAuthorization, remoteChanged, onClearRemoteChanged }: DocumentEditorPaneProps) {
  const generation = useRef(0);
  const scope = JSON.stringify([baseUrl, dataset, docId, perspective, expectedType]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [published, setPublished] = useState<boolean | null>(isPublished ?? null);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [schema, setSchema] = useState<ContentfnSchema | null>(null);
  const [originalDoc, setOriginalDoc] = useState<ContentfnDocument | null>(null);
  const [formState, setFormState] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saveLoading, setSaveLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{ code: string; message: string; path?: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [previewRefreshTrigger, setPreviewRefreshTrigger] = useState(0);
  const [mediaPickerField, setMediaPickerField] = useState<{ scope: string; path: readonly string[] } | null>(null);
  const currentEditorScope = useRef(scope); currentEditorScope.current = scope;

  const load = useCallback(async () => {
    if (!dataset || !docId) return;
    setMediaPickerField(null);
    const requestGeneration = ++generation.current;
    setLoading(true);
    setSaveLoading(false);
    setOriginalDoc(null);
    setFormState({});
    setPublished(null);
    setPublicationError(null);
    setValidationError(null);
    setServerError(null);
    setConflict(false);
    const [schemaRes, docRes, publishedRes] = await Promise.all([
      getSchema({ baseUrl }, dataset),
      getDoc({ baseUrl }, { dataset, id: docId, perspective }),
      cmsfnApiUrl && perspective === "draft" ? getDoc({ baseUrl }, { dataset, id: docId.replace(/^drafts\./, ""), perspective: "published" }) : Promise.resolve(null),
    ]);
    if (requestGeneration !== generation.current) return;
    setLoading(false);
    if (!schemaRes.ok) {
      setServerError({ code: schemaRes.error.code, message: schemaRes.error.message });
      return;
    }
    if (!docRes.ok) {
      setServerError({ code: docRes.error.code, message: docRes.error.message, path: (docRes.error.details as { path?: string })?.path });
      return;
    }
    if (expectedType !== undefined && docRes.result._type !== expectedType) {
      setServerError({ code: "VALIDATION_FAILED", message: "Document type does not match this desk singleton" });
      return;
    }
    if (perspective === "published") setPublished(true);
    else if (publishedRes?.ok) setPublished(true);
    else if (publishedRes && publishedRes.error.code === "DOCUMENT_NOT_FOUND") setPublished(false);
    else if (publishedRes) setPublicationError("Publication state could not be verified");
    setSchema(schemaRes.result);
    setOriginalDoc(docRes.result);
    setLoadedScope(scope);
    const doc = docRes.result as Record<string, unknown>;
    const userFields = Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("_")));
    setFormState(userFields);
  }, [baseUrl, dataset, docId, perspective, expectedType, cmsfnApiUrl, scope]);

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  const docType = schema?.documentTypes?.find((t) => t.name === originalDoc?._type);
  const typeNotFound = originalDoc && schema && !docType;

  const handleSave = useCallback(async () => {
    if (loadedScope !== scope || perspective !== "draft" || !originalDoc || !schema || !docType) return;
    const requestGeneration = generation.current;
    setValidationError(null);
    setServerError(null);
    setConflict(false);
    for (const f of docType.fields) {
      if (f.required && (formState[f.name] === undefined || formState[f.name] === "" || formState[f.name] === null)) {
        setValidationError(f.name);
        return;
      }
    }
    const richtextCheck = checkRichtextLimits(formState, docType);
    if (!richtextCheck.ok) {
      setValidationError(richtextCheck.path);
      return;
    }
    setSaveLoading(true);
    const fullCurrent = { ...formState, _id: originalDoc._id, _type: originalDoc._type };
    const ops = buildPatchOps(originalDoc as Record<string, unknown>, fullCurrent);
    const res = await patchDoc(
      { baseUrl },
      { dataset, id: originalDoc._id, ifRev: originalDoc._rev, ops }
    );
    if (requestGeneration !== generation.current) return;
    setSaveLoading(false);
    if (res.ok) {
      setOriginalDoc(res.result);
      setServerError(null);
      setPreviewRefreshTrigger((t) => t + 1);
    } else {
      if (res.error.code === "REV_CONFLICT") {
        setConflict(true);
      } else {
        setServerError({
          code: res.error.code,
          message: res.error.message,
          path: (res.error.details as { path?: string })?.path,
        });
      }
    }
  }, [baseUrl, dataset, docId, perspective, originalDoc, schema, docType, formState, loadedScope, scope]);

  const handleRefresh = useCallback(async () => {
    setConflict(false);
    await load();
  }, [load]);

  const handleReApply = useCallback(async () => {
    if (loadedScope !== scope || perspective !== "draft" || !originalDoc || !schema || !docType) return;
    const requestGeneration = generation.current;
    const docRes = await getDoc({ baseUrl }, { dataset, id: docId, perspective: "draft" });
    if (requestGeneration !== generation.current) return;
    if (!docRes.ok) {
      setServerError({ code: docRes.error.code, message: docRes.error.message });
      return;
    }
    setOriginalDoc(docRes.result);
    setConflict(false);
    setSaveLoading(true);
    const fullCurrent = { ...formState, _id: docRes.result._id, _type: docRes.result._type };
    const ops = buildPatchOps(docRes.result as Record<string, unknown>, fullCurrent);
    const res = await patchDoc(
      { baseUrl },
      { dataset, id: docRes.result._id, ifRev: docRes.result._rev, ops }
    );
    if (requestGeneration !== generation.current) return;
    setSaveLoading(false);
    if (res.ok) {
      setOriginalDoc(res.result);
      setServerError(null);
    } else if (res.error.code === "REV_CONFLICT") {
      setConflict(true);
    } else {
      setServerError({
        code: res.error.code,
        message: res.error.message,
        path: (res.error.details as { path?: string })?.path,
      });
    }
  }, [baseUrl, dataset, docId, perspective, originalDoc, schema, docType, formState, loadedScope, scope]);

  const handleFork = async () => {
    if (loadedScope !== scope || perspective !== "published" || !originalDoc || !onOpenDraft) return;
    const requestGeneration = generation.current;
    setSaveLoading(true); setServerError(null);
    const result = await forkDoc({ baseUrl }, { dataset, id: originalDoc._id, ifRev: originalDoc._rev });
    if (requestGeneration !== generation.current) return;
    const draft = !result.ok && result.error.code === "DOCUMENT_ALREADY_EXISTS"
      ? await getDoc({ baseUrl }, { dataset, id: originalDoc._id, perspective: "draft" }) : result;
    if (requestGeneration !== generation.current) return;
    setSaveLoading(false);
    if (draft.ok) onOpenDraft(draft.result._id);
    else setServerError({ code: draft.error.code, message: draft.error.message });
  };

  if (loading || (originalDoc !== null && loadedScope !== scope)) return <div data-editor-pane data-loading>Loading…</div>;
  if (serverError && !originalDoc) {
    return (
      <div data-editor-pane data-error data-error-code={serverError.code}>
        <p>{serverError.message}</p>
      </div>
    );
  }
  if (typeNotFound) {
    return (
      <div data-editor-pane data-error data-error-code="VALIDATION_FAILED">
        <p>Unknown document type: {(originalDoc as ContentfnDocument)?._type}</p>
      </div>
    );
  }
  if (!docType || !originalDoc) return null;

  if (perspective === "published") return (
    <section data-editor-pane data-perspective="published" data-doc-id={originalDoc._id}>
      <h2>Published document</h2>
      <p>This is the published version. Create or open a draft to edit.</p>
      <button type="button" data-published-refresh disabled={saveLoading} onClick={() => void load()}>Refresh published version</button>
      {serverError && <p role="alert" data-fork-error>{serverError.message}</p>}
      <dl>{docType.fields.map(field => <div key={field.name}><dt>{field.name}</dt><dd>{typeof originalDoc[field.name] === "string" ? String(originalDoc[field.name]) : JSON.stringify(originalDoc[field.name])}</dd></div>)}</dl>
      {onOpenDraft && <button type="button" data-create-draft disabled={saveLoading} onClick={() => void handleFork()}>Create or open draft</button>}
      {cmsfnApiUrl && <PublishButton cmsfnApiUrl={cmsfnApiUrl} dataset={dataset} docId={originalDoc._id} isPublished allowPublish={false} disabled={saveLoading} onUnpublished={onUnpublished ?? (() => void load())} />}
    </section>
  );

  const errorPath = serverError?.path ?? validationError ?? null;

  const docRecord = originalDoc as Record<string, unknown>;
  const currentCms = docRecord._cms as CmsfnWorkflowMetadata | undefined;

  return (
    <div data-editor-pane data-perspective="draft" data-doc-id={docId} data-draft-indicator={currentCms?.state === "draft" ? "true" : undefined}>
      <h2>Draft document</h2>
      {remoteChanged && (
        <div data-remote-changed-banner role="alert">
          <span>Document changed elsewhere.</span>
          <button type="button" onClick={() => { handleRefresh(); onClearRemoteChanged?.(); }}>
            Refresh
          </button>
        </div>
      )}
      {conflict && (
        <ConflictBanner onRefresh={handleRefresh} onReApply={handleReApply} />
      )}
      <WorkflowControls
        baseUrl={baseUrl}
        dataset={dataset}
        docId={originalDoc._id}
        currentRev={originalDoc._rev}
        currentCms={currentCms}
        onStateSaved={() => load()}
        disabled={saveLoading}
      />
      {publicationError && <p role="alert">{publicationError}</p>}
      {cmsfnApiUrl && published !== null && (
        <PublishButton
          cmsfnApiUrl={cmsfnApiUrl}
          dataset={dataset}
          docId={originalDoc._id.replace(/^drafts\./, "")}
          isPublished={published}
          onPublished={() => load()}
          onUnpublished={() => load()}
          disabled={saveLoading}
        />
      )}
      {mediaPickerField !== null && mediaPickerField.scope === scope && loadedScope === scope && (
        <MediaLibraryPane
          onClose={() => setMediaPickerField(null)}
          baseUrl={baseUrl}
          dataset={dataset}
          maxUploadBytes={maxUploadBytes}
          onSelectAsset={(ref: CanonicalAssetRef) => {
            if (currentEditorScope.current !== scope || mediaPickerField.scope !== scope || loadedScope !== scope) return;
            try {
              insertAssetAtPath(formState, mediaPickerField.path, ref);
              setFormState(previous => { try { return insertAssetAtPath(previous, mediaPickerField.path, ref); } catch { return previous; } });
              setMediaPickerField(null);
            }
            catch { setValidationError('Asset field could not be updated.'); }
          }}
        />
      )}
      {previewConfig && (
        <PreviewPane
          previewEnabled={previewConfig.enabled}
          targetOrigin={previewConfig.targetOrigin}
          resolveUrl={previewConfig.resolveUrl}
          cmsfnApiUrl={cmsfnApiUrl}
          dataset={dataset}
          doc={originalDoc}
          realtimeUrl={realtimeUrl}
          refreshTrigger={previewRefreshTrigger}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        {docType.fields.map((field) => (
          <div key={field.name} data-editor-field={field.name} data-required={field.required ?? undefined}>
            <label>
              {field.name}
              {field.required && <span data-required-indicator> *</span>}
            </label>
            {renderField(
              field,
              field.name,
              formState[field.name],
              (v) => setFormState((prev) => ({ ...prev, [field.name]: v })),
              errorPath,
              {
                onOpenMediaPicker: (_name, segments) => setMediaPickerField({ scope, path: segments }),
                baseUrl,
                cmsfnApiUrl, allowContentfnReferenceAuthorization, referenceOwnerScope: scope,
                dataset,
                docTypeName: docType.name,
              }
            )}
          </div>
        ))}
        <button type="submit" disabled={saveLoading} data-editor-save>
          Save
        </button>
      </form>
    </div>
  );
}
