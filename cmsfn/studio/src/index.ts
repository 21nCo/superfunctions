/**
 * @cmsfn/studio — CmsFn Studio UI (desk, dataset selector, etc.).
 */

import type { CmsfnStudioConfig } from "@cmsfn/core";

export { App } from "./app.js";
export { DeskTree } from "./desk/DeskTree.js";
export type { DocumentListNode } from "./desk/DeskTree.js";
export { DatasetSelector, getInitialDataset } from "./datasets/DatasetSelector.js";
export { loadConfig } from "./config/loadConfig.js";
export { DocumentListPane } from "./panes/list/DocumentListPane.js";
export { ListErrorState } from "./panes/list/ListErrorState.js";
export { useCfqlQuery } from "./panes/list/useCfqlQuery.js";
export { queryContentfn, getSchema, getDoc, patchDoc } from "./contentfn/client.js";
export { DocumentEditorPane } from "./panes/editor/DocumentEditorPane.js";
export { ConflictBanner } from "./editor/conflicts/ConflictBanner.js";
export { buildPatchOps } from "./editor/save/buildPatchOps.js";
export { renderField } from "./editor/renderField.js";

/**
 * Boot: validate config and return booted flag.
 * Full desk rendering is done by mounting <App config={config} />.
 */
export function boot(config: CmsfnStudioConfig): { booted: true } {
  if (!config?.datasets?.length) {
    throw new Error("CmsFn Studio config must have at least one dataset.");
  }
  return { booted: true };
}

export type { CmsfnStudioConfig };
