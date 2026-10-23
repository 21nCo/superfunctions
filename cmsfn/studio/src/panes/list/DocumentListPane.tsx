/**
 * Document list pane: CFQL-powered, dataset from selector, opaque cursor paging.
 */

import { useEffect } from "react";
import type { CmsfnDeskNode } from "cmsfn";
import { useCfqlQuery } from "./useCfqlQuery.js";
import { ListErrorState } from "./ListErrorState.js";

export interface DocumentListPaneProps {
  baseUrl: string;
  dataset: string;
  node: Extract<CmsfnDeskNode, { kind: "documentList" }>;
  limit?: number;
  /** When set, clicking a doc opens it in the editor. */
  onOpenDoc?: (docId: string) => void;
  /** When this value changes, list refetches (e.g. realtime publish event). TV-COLLAB-001 */
  refreshTrigger?: number;
}

export function DocumentListPane({ baseUrl, dataset, node, limit = 20, onOpenDoc, refreshTrigger }: DocumentListPaneProps) {
  const { data, nextCursor, loading, error, runQuery, loadNextPage } = useCfqlQuery({
    baseUrl,
    dataset,
    types: node.types,
    orderBy: node.defaultOrder,
    limit,
  });

  useEffect(() => {
    if (dataset) runQuery();
  }, [dataset, node.types.join(","), runQuery]);

  useEffect(() => {
    if (refreshTrigger != null && refreshTrigger > 0 && dataset) runQuery();
  }, [refreshTrigger, dataset, runQuery]);

  if (error) {
    return (
      <ListErrorState
        code={error.code}
        message={error.message}
        onRetry={runQuery}
      />
    );
  }

  return (
    <div data-document-list-pane>
      {loading && data.length === 0 ? (
        <p data-list-loading>Loading…</p>
      ) : (
        <>
          <ul data-document-list role="list">
            {data.map((doc) => (
              <li key={doc._id} data-doc-id={doc._id}>
                {onOpenDoc ? (
                  <button
                    type="button"
                    data-doc-open
                    onClick={() => onOpenDoc(doc._id)}
                  >
                    <span data-doc-type>{doc._type}</span>
                    <span data-doc-id-value>{doc._id}</span>
                  </button>
                ) : (
                  <>
                    <span data-doc-type>{doc._type}</span>
                    <span data-doc-id-value>{doc._id}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {nextCursor && (
            <button
              type="button"
              data-list-next-page
              onClick={() => loadNextPage(nextCursor)}
              disabled={loading}
            >
              Next page
            </button>
          )}
        </>
      )}
    </div>
  );
}
