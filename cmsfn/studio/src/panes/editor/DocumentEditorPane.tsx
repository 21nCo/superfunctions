/**
 * Schema-driven document editor: load schema + doc, render widgets, save via patch with ifRev.
 * Handles VALIDATION_FAILED (field path) and REV_CONFLICT (ConflictBanner).
 */

import { useState, useEffect, useCallback } from "react";
import type { ContentfnSchema, ContentfnDocument, ContentfnDocumentType } from "@contentfn/core";
import { getSchema, getDoc, patchDoc } from "../../contentfn/client.js";
import { buildPatchOps } from "../../editor/save/buildPatchOps.js";
import { checkRichtextLimits } from "../../limits/precheck.js";
import { renderField } from "../../editor/renderField.js";
import { ConflictBanner } from "../../editor/conflicts/ConflictBanner.js";
import type { CmsfnWorkflowMetadata } from "@cmsfn/core";
import { WorkflowControls } from "../../workflow/WorkflowControls.js";
import { PublishButton } from "../../publish/PublishButton.js";
import { PreviewPane } from "../preview/PreviewPane.js";
import { MediaLibraryPane } from "../media/MediaLibraryPane.js";
import type { CanonicalAssetRef } from "../../media/insertAssetRef.js";

export interface DocumentEditorPaneProps {
  baseUrl: string;
  dataset: string;
  docId: string;
  /** When set, Publish/Unpublish are shown and call CmsFn server. */
  cmsfnApiUrl?: string;
  /** When true, show Unpublish instead of Publish. */
  isPublished?: boolean;
  /** When set, preview pane is shown (token + iframe). */
  previewConfig?: { enabled: boolean; targetOrigin: string; resolveUrl: (doc: unknown) => string };
  /** Optional ContentFn realtime WebSocket URL for live preview updates. */
  realtimeUrl?: string;
  /** Max upload bytes for media library (client pre-check). */
  maxUploadBytes?: number;
  /** When true, show "remote changed" banner (TV-COLLAB-002). */
  remoteChanged?: boolean;
  /** Callback when user dismisses/refreshes after remote change. */
  onClearRemoteChanged?: () => void;
}

export function DocumentEditorPane({ baseUrl, dataset, docId, cmsfnApiUrl, isPublished, previewConfig, realtimeUrl, maxUploadBytes, remoteChanged, onClearRemoteChanged }: DocumentEditorPaneProps) {
  const [schema, setSchema] = useState<ContentfnSchema | null>(null);
  const [originalDoc, setOriginalDoc] = useState<ContentfnDocument | null>(null);
  const [formState, setFormState] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saveLoading, setSaveLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<{ code: string; message: string; path?: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [previewRefreshTrigger, setPreviewRefreshTrigger] = useState(0);
  const [mediaPickerField, setMediaPickerField] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!dataset || !docId) return;
    setLoading(true);
    setValidationError(null);
    setServerError(null);
    setConflict(false);
    const [schemaRes, docRes] = await Promise.all([
      getSchema({ baseUrl }, dataset),
      getDoc({ baseUrl }, { dataset, id: docId, perspective: "draft" }),
    ]);
    setLoading(false);
    if (!schemaRes.ok) {
      setServerError({ code: schemaRes.error.code, message: schemaRes.error.message });
      return;
    }
    if (!docRes.ok) {
      setServerError({ code: docRes.error.code, message: docRes.error.message, path: (docRes.error.details as { path?: string })?.path });
      return;
    }
    setSchema(schemaRes.result);
    setOriginalDoc(docRes.result);
    const doc = docRes.result as Record<string, unknown>;
    const userFields = Object.fromEntries(Object.entries(doc).filter(([k]) => !k.startsWith("_")));
    setFormState(userFields);
  }, [baseUrl, dataset, docId]);

  useEffect(() => {
    load();
  }, [load]);

  const docType = schema?.documentTypes?.find((t) => t.name === originalDoc?._type);
  const typeNotFound = originalDoc && schema && !docType;

  const handleSave = useCallback(async () => {
    if (!originalDoc || !schema || !docType) return;
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
      { dataset, id: docId, ifRev: originalDoc._rev, ops }
    );
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
  }, [baseUrl, dataset, docId, originalDoc, schema, docType, formState]);

  const handleRefresh = useCallback(async () => {
    setConflict(false);
    await load();
  }, [load]);

  const handleReApply = useCallback(async () => {
    if (!originalDoc || !schema || !docType) return;
    const docRes = await getDoc({ baseUrl }, { dataset, id: docId, perspective: "draft" });
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
      { dataset, id: docId, ifRev: docRes.result._rev, ops }
    );
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
  }, [baseUrl, dataset, docId, schema, docType, formState]);

  if (loading) return <div data-editor-pane data-loading>Loading…</div>;
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

  const errorPath = serverError?.path ?? validationError ?? null;

  const docRecord = originalDoc as Record<string, unknown>;
  const currentCms = docRecord._cms as CmsfnWorkflowMetadata | undefined;

  return (
    <div data-editor-pane data-doc-id={docId} data-draft-indicator={currentCms?.state === "draft" ? "true" : undefined}>
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
        docId={docId}
        currentRev={originalDoc._rev}
        currentCms={currentCms}
        onStateSaved={() => load()}
        disabled={saveLoading}
      />
      {cmsfnApiUrl && (
        <PublishButton
          cmsfnApiUrl={cmsfnApiUrl}
          dataset={dataset}
          docId={docId}
          isPublished={isPublished}
          onPublished={() => load()}
          onUnpublished={() => load()}
          disabled={saveLoading}
        />
      )}
      {mediaPickerField !== null && (
        <MediaLibraryPane
          baseUrl={baseUrl}
          dataset={dataset}
          maxUploadBytes={maxUploadBytes}
          onSelectAsset={(ref: CanonicalAssetRef) => {
            setFormState((prev) => ({ ...prev, [mediaPickerField]: ref }));
            setMediaPickerField(null);
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
                onOpenMediaPicker: (name) => setMediaPickerField(name),
                baseUrl,
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
