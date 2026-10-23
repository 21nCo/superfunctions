/**
 * Studio app shell: desk + dataset selector + list pane.
 * Renders at /studio; config loaded via loadConfig() or passed in for tests.
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import type { CmsfnStudioConfig } from "cmsfn";
import { loadConfig, getInitialDataset } from "./config/loadConfig.js";
import { DeskTree } from "./desk/DeskTree.js";
import type { DocumentListNode } from "./desk/DeskTree.js";
import { DatasetSelector } from "./datasets/DatasetSelector.js";
import { DocumentListPane } from "./panes/list/DocumentListPane.js";
import { DocumentEditorPane } from "./panes/editor/DocumentEditorPane.js";
import { subscribeToDataset } from "./realtime/subscribe.js";
import { applyEvents } from "./realtime/applyEvents.js";

export interface AppProps {
  /** When provided, used instead of loadConfig() (e.g. for tests). */
  config?: CmsfnStudioConfig | null;
}

/**
 * Root Studio app: deterministic desk and dataset selection.
 * Initial dataset = first in config.
 */
export function App({ config: configProp }: AppProps = {}) {
  const configFromWindow = useMemo(() => loadConfig(), []);
  const config = configProp ?? configFromWindow;

  const [dataset, setDataset] = useState<string>(() =>
    config ? getInitialDataset(config) : ""
  );
  const [selectedList, setSelectedList] = useState<DocumentListNode | null>(null);
  const [perspective, setPerspective] = useState<"draft" | "published">("draft");
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [listRefreshTrigger, setListRefreshTrigger] = useState(0);
  const [remoteChanged, setRemoteChanged] = useState(false);

  const handleRealtimeEvent = useCallback(
    (event: { type: string; dataset?: string; docId?: string }) => {
      const result = applyEvents(event, {
        openDocId: selectedDocId,
        listDataset: selectedList ? dataset : null,
      });
      if (result.listShouldRefetch) setListRefreshTrigger((t) => t + 1);
      if (result.showRemoteChangedBanner) setRemoteChanged(true);
    },
    [selectedDocId, selectedList, dataset]
  );

  useEffect(() => {
    if (!config?.contentfn?.realtimeUrl || !dataset) return;
    return subscribeToDataset({
      realtimeUrl: config.contentfn.realtimeUrl,
      dataset,
      onEvent: handleRealtimeEvent,
    });
  }, [config?.contentfn?.realtimeUrl, dataset, handleRealtimeEvent]);

  if (!config) {
    return (
      <div data-studio-root data-studio-state="no-config">
        <p>No Studio config available.</p>
      </div>
    );
  }

  return (
    <div data-studio-root data-studio-state="ready" data-current-dataset={dataset}>
      <header data-studio-header>
        <DatasetSelector
          config={config}
          value={dataset}
          onDatasetChange={(next) => { setDataset(next); setSelectedDocId(null); setRemoteChanged(false); }}
        />
        <label>Document perspective
          <select aria-label="Document perspective" value={perspective} onChange={(event) => {
            setPerspective(event.target.value === "published" ? "published" : "draft");
            setSelectedDocId(null); setRemoteChanged(false);
          }}>
            <option value="draft">Drafts</option><option value="published">Published</option>
          </select>
        </label>
      </header>
      <aside data-studio-desk>
        <DeskTree
          root={config.desk}
          onSelectDocumentList={(list) => { setSelectedList(list); setSelectedDocId(null); setRemoteChanged(false); }}
        />
      </aside>
      <main data-studio-pane>
        {selectedDocId ? (
          <>
            <button type="button" data-editor-back onClick={() => setSelectedDocId(null)}>
              Back to list
            </button>
            <DocumentEditorPane
              key={`${dataset}:${perspective}:${selectedDocId}`}
              perspective={perspective}
              onOpenDraft={(id) => { setPerspective("draft"); setSelectedDocId(id); }}
              onUnpublished={() => { setSelectedDocId(null); setListRefreshTrigger((value) => value + 1); }}
              baseUrl={config.contentfn.baseUrl}
              dataset={dataset}
              docId={selectedDocId}
              cmsfnApiUrl={config.cmsfn?.apiUrl}
              previewConfig={config.preview}
              realtimeUrl={config.contentfn.realtimeUrl}
              maxUploadBytes={config.limits?.maxUploadBytes}
              remoteChanged={remoteChanged}
              onClearRemoteChanged={() => setRemoteChanged(false)}
            />
          </>
        ) : selectedList ? (
          <DocumentListPane
            key={`${dataset}:${perspective}`}
            perspective={perspective}
            baseUrl={config.contentfn.baseUrl}
            dataset={dataset}
            node={selectedList}
            onOpenDoc={(id) => {
              setSelectedDocId(id);
              setRemoteChanged(false);
            }}
            refreshTrigger={listRefreshTrigger}
          />
        ) : null}
      </main>
    </div>
  );
}
