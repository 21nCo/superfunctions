/**
 * Deterministic desk navigation tree from CmsfnStudioConfig.desk.
 * Uses @cmsfn/core deskNodeKeys for stable keys and order.
 */

import type { CmsfnDeskNode } from "@cmsfn/core";
import { deskNodeKeys } from "@cmsfn/core";

export type DocumentListNode = Extract<CmsfnDeskNode, { kind: "documentList" }>;

export interface DeskTreeProps {
  root: CmsfnDeskNode;
  onSelectDocumentList?: (node: DocumentListNode) => void;
}

function DeskNode({ node, nodeKey, onSelectDocumentList }: { node: CmsfnDeskNode; nodeKey: string; onSelectDocumentList?: (node: DocumentListNode) => void }) {
  if (node.kind === "divider") {
    return <li key={nodeKey} data-desk-kind="divider" aria-hidden="true" />;
  }
  if (node.kind === "group") {
    return (
      <li key={nodeKey} data-desk-kind="group" data-desk-key={nodeKey}>
        <span data-desk-title>{node.title}</span>
        {node.children.length > 0 && (
          <ul role="group" aria-label={node.title}>
            {node.children.map((child, i) => {
              const key = nodeKey === "0" ? `0-${i}` : `${nodeKey}-${i}`;
              return <DeskNode key={key} node={child} nodeKey={key} onSelectDocumentList={onSelectDocumentList} />;
            })}
          </ul>
        )}
      </li>
    );
  }
  if (node.kind === "documentList") {
    return (
      <li key={nodeKey} data-desk-kind="documentList" data-desk-key={nodeKey} data-desk-dataset={node.dataset}>
        <button type="button" data-desk-list-trigger onClick={() => onSelectDocumentList?.(node)}>
          <span data-desk-title>{node.title}</span>
        </button>
      </li>
    );
  }
  if (node.kind === "singleton") {
    return (
      <li key={nodeKey} data-desk-kind="singleton" data-desk-key={nodeKey} data-desk-dataset={node.dataset} data-desk-type={node.type} data-desk-id={node.id}>
        <span data-desk-title>{node.title}</span>
      </li>
    );
  }
  return null;
}

/**
 * Renders the desk tree with deterministic keys (depth-first, config order).
 */
export function DeskTree({ root, onSelectDocumentList }: DeskTreeProps) {
  const entries = deskNodeKeys(root);
  if (entries.length === 0) return null;
  const rootEntry = entries[0];
  if (rootEntry.node.kind === "divider") {
    return <nav data-desk-root aria-label="Desk"><ul /></nav>;
  }
  return (
    <nav data-desk-root aria-label="Desk">
      <ul role="tree">
        <DeskNode node={rootEntry.node} nodeKey={rootEntry.key} onSelectDocumentList={onSelectDocumentList} />
      </ul>
    </nav>
  );
}
