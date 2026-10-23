import { HistoryPane } from "./panes/history/HistoryPane.js";
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
import { OpsPane } from "./panes/ops/OpsPane.js";
import { ReleasesPane } from "./panes/releases/ReleasesPane.js";
import { EventsPane } from "./panes/audit/EventsPane.js";
import { WebhooksPane } from "./panes/audit/WebhooksPane.js";
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
  const [auditPane, setAuditPane] = useState<"events" | "webhooks" | "releases" | "ops" | null>(null);
  const [selectedList, setSelectedList] = useState<DocumentListNode | null>(null);
  const [perspective, setPerspective] = useState<"draft" | "published">("draft");
  const [expectedType, setExpectedType] = useState<string | undefined>();
  const [navigationError, setNavigationError] = useState<string | null>(null);
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
          onDatasetChange={(next) => { setDataset(next); setSelectedDocId(null); setExpectedType(undefined); setNavigationError(null); setRemoteChanged(false); }}
        />
        <label>Document perspective
          <select aria-label="Document perspective" value={perspective} onChange={(event) => {
            setPerspective(event.target.value === "published" ? "published" : "draft");
            setSelectedDocId(null); setNavigationError(null); setRemoteChanged(false);
          }}>
            <option value="draft">Drafts</option><option value="published">Published</option>
          </select>
        </label>
      </header>
      <aside data-studio-desk>
        <DeskTree
          root={config.desk}
          onSelectDocumentList={(list) => { setAuditPane(null); setSelectedList(list); setSelectedDocId(null); setExpectedType(undefined); setNavigationError(null); setRemoteChanged(false); }}
          onSelectSingleton={(node) => {
            setAuditPane(null);
            setSelectedList(null); setSelectedDocId(null); setRemoteChanged(false);
            if (!node.id.replace(/^drafts\./, "") || !node.type || !config.datasets.some(item => item.name === node.dataset)) {
              setNavigationError("This singleton is not available in the configured datasets");
              return;
            }
            setNavigationError(null); setDataset(node.dataset); setExpectedType(node.type);
            setSelectedDocId(node.id.replace(/^drafts\./, ""));
          }}
        />
        <nav aria-label="Operations">
          {(["events", "webhooks", "releases", "ops"] as const).map(kind => <button key={kind} type="button" data-audit-nav={kind} aria-pressed={auditPane === kind} onClick={() => { setAuditPane(kind); setSelectedDocId(null); setSelectedList(null); setNavigationError(null); setRemoteChanged(false); }}>{kind === "events" ? "Audit events" : kind === "webhooks" ? "Webhook deliveries" : kind === "releases" ? "Releases" : "Import / export"}</button>)}
        </nav>
      </aside>
      <main data-studio-pane>
        {navigationError && <p role="alert" data-desk-error>{navigationError}</p>}
        {auditPane ? (!config.cmsfn?.apiUrl ? <p role="alert" data-audit-unavailable>{auditPane === "ops" ? "Import/export requires a configured CmsFn API." : auditPane === "releases" ? "Releases require a configured CmsFn API." : "Audit requires a configured CmsFn API."}</p> : !config.datasets.some(item => item.name === dataset) ? <p role="alert" data-audit-unavailable>Select a configured dataset.</p> : auditPane === "ops" ? <OpsPane cmsfnApiUrl={config.cmsfn.apiUrl} dataset={dataset} /> : auditPane === "releases" ? <ReleasesPane cmsfnApiUrl={config.cmsfn.apiUrl} dataset={dataset} /> : auditPane === "events" ? <EventsPane key={`events:${dataset}`} cmsfnApiUrl={config.cmsfn.apiUrl} dataset={dataset} /> : <WebhooksPane key={`webhooks:${dataset}`} cmsfnApiUrl={config.cmsfn.apiUrl} dataset={dataset} />) : selectedDocId ? (
          <>
            <button type="button" data-editor-back onClick={() => setSelectedDocId(null)}>
              {selectedList ? "Back to list" : "Back to desk"}
            </button>
            <HistoryPane key={`history:${dataset}:${perspective}:${selectedDocId}`} baseUrl={config.contentfn.baseUrl} dataset={dataset} docId={selectedDocId} />
            <DocumentEditorPane
              key={`${dataset}:${perspective}:${selectedDocId}`}
              perspective={perspective}
              expectedType={expectedType}
              onOpenDraft={(id) => { setPerspective("draft"); setSelectedDocId(id); }}
              onUnpublished={() => { setSelectedDocId(null); setListRefreshTrigger((value) => value + 1); }}
              baseUrl={config.contentfn.baseUrl}
              dataset={dataset}
              docId={selectedDocId}
              cmsfnApiUrl={config.cmsfn?.apiUrl}
              previewConfig={config.preview}
              realtimeUrl={config.contentfn.realtimeUrl}
              maxRichtextBlocks={config.limits?.maxRichtextBlocks}
              maxUploadBytes={config.limits?.maxUploadBytes}
              allowContentfnReferenceAuthorization={config.references?.authorization === "contentfn"}
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
