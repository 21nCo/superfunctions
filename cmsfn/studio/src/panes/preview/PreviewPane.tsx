/**
 * Preview pane: iframe with preview URL + token; updates on draft changes (realtime or refresh callback).
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { subscribeToDoc } from "../../realtime/subscribe.js";

const PREVIEW_TOKEN_PARAM = "cmsfn_preview_token";

export interface PreviewPaneProps {
  /** When false or missing, show deterministic disabled UI. */
  previewEnabled?: boolean;
  targetOrigin: string;
  resolveUrl: (doc: unknown) => string;
  /** CmsFn server URL for POST /cmsfn/preview/token. */
  cmsfnApiUrl?: string;
  dataset: string;
  /** Current doc (draft) for resolveUrl and token scope. */
  doc: unknown;
  /** Optional WebSocket URL for ContentFn realtime; when set, preview refreshes on events. */
  realtimeUrl?: string;
  /** When set, preview will refresh when this is called (e.g. after save). */
  refreshTrigger?: number;
}

async function fetchPreviewToken(
  cmsfnApiUrl: string,
  dataset: string,
  docId: string
): Promise<{ token: string; expiresAt: string } | null> {
  const base = cmsfnApiUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/cmsfn/preview/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataset, docId }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) return null;
  const r = data.result as { token?: string; expiresAt?: string };
  return r?.token && r?.expiresAt ? { token: r.token, expiresAt: r.expiresAt } : null;
}

function buildPreviewUrl(baseUrl: string, token: string): string {
  const u = new URL(baseUrl);
  u.searchParams.set(PREVIEW_TOKEN_PARAM, token);
  return u.toString();
}

export function PreviewPane({
  previewEnabled,
  targetOrigin,
  resolveUrl,
  cmsfnApiUrl,
  dataset,
  doc,
  realtimeUrl,
  refreshTrigger,
}: PreviewPaneProps) {
  const [token, setToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const docId = (doc as { _id?: string })?._id;

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  // Request token when doc or config changes
  useEffect(() => {
    if (!previewEnabled || !cmsfnApiUrl || !docId) {
      setToken(null);
      setTokenError(false);
      return;
    }
    let cancelled = false;
    fetchPreviewToken(cmsfnApiUrl, dataset, docId).then((t) => {
      if (!cancelled) {
        setToken(t?.token ?? null);
        setTokenError(!t);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [previewEnabled, cmsfnApiUrl, dataset, docId]);

  // Realtime subscription: on event, refresh preview
  useEffect(() => {
    if (!docId || !realtimeUrl) return;
    const unsub = subscribeToDoc({
      realtimeUrl,
      dataset,
      docId,
      onUpdate: refresh,
    });
    return unsub;
  }, [realtimeUrl, dataset, docId, refresh]);

  // When parent signals refresh (e.g. after save)
  const prevTrigger = useRef(refreshTrigger);
  useEffect(() => {
    if (refreshTrigger != null && refreshTrigger !== prevTrigger.current) {
      prevTrigger.current = refreshTrigger;
      refresh();
    }
  }, [refreshTrigger, refresh]);

  if (!previewEnabled) {
    return (
      <div data-preview-pane data-preview-disabled="true">
        <p>Preview is not configured.</p>
      </div>
    );
  }

  if (!cmsfnApiUrl || !docId) {
    return (
      <div data-preview-pane data-preview-disabled="true">
        <p>Preview requires CmsFn server URL and an open document.</p>
      </div>
    );
  }

  if (tokenError || !token) {
    return (
      <div data-preview-pane data-preview-error="true">
        <p>{tokenError ? "Failed to load preview token." : "Loading preview…"}</p>
      </div>
    );
  }

  const baseUrl = resolveUrl(doc);
  const previewUrl = buildPreviewUrl(baseUrl, token);

  return (
    <div data-preview-pane data-preview-visible="true">
      <iframe
        key={refreshKey}
        data-preview-iframe
        title="Preview"
        src={previewUrl}
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", border: "none" }}
      />
    </div>
  );
}
