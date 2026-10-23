/**
 * Apply realtime events to derive list refetch and remote-changed banner (COLLAB-001, COLLAB-002).
 * Pure: given event + context, returns what the UI should do.
 */

export interface RealtimeEvent {
  type: string;
  dataset?: string;
  docId?: string;
}

export interface ApplyEventsContext {
  /** Currently open document id (draft or published id). */
  openDocId: string | null;
  /** Dataset of the current list pane, if any. */
  listDataset: string | null;
}

export interface ApplyEventsResult {
  /** List pane should refetch when this is true (e.g. publish in same dataset). */
  listShouldRefetch: boolean;
  /** Editor should show "remote changed" banner when this is true (doc was patched elsewhere). */
  showRemoteChangedBanner: boolean;
}

/**
 * Deterministic: given one event and context, returns UI actions.
 * - Publish / patch in same dataset → listShouldRefetch.
 * - Patch for open doc → showRemoteChangedBanner.
 */
export function applyEvents(
  event: RealtimeEvent,
  ctx: ApplyEventsContext
): ApplyEventsResult {
  const datasetMatch = ctx.listDataset != null && event.dataset === ctx.listDataset;
  const docId = event.docId;
  const openId = ctx.openDocId;
  const norm = (id: string) => id.replace(/^drafts\./, "");
  const openMatch =
    openId != null &&
    docId != null &&
    (docId === openId ||
      norm(docId) === norm(openId) ||
      docId === openId.replace(/^drafts\./, "") ||
      openId === `drafts.${docId}`);

  let listShouldRefetch = false;
  let showRemoteChangedBanner = false;

  if (event.type === "doc.publish" || event.type === "publish" || event.type === "event") {
    if (datasetMatch) listShouldRefetch = true;
  }
  if (
    event.type === "doc.patch" ||
    event.type === "patch" ||
    event.type === "event"
  ) {
    if (datasetMatch) listShouldRefetch = true;
    if (openMatch) showRemoteChangedBanner = true;
  }

  return { listShouldRefetch, showRemoteChangedBanner };
}
