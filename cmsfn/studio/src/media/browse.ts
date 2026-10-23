/**
 * Browse assets with deterministic ordering (ContentFn: createdAt desc, assetId asc).
 */

import { listAssets } from "../contentfn/client.js";
import type { ContentfnClientConfig } from "../contentfn/client.js";
import type { AssetListItem } from "../contentfn/client.js";

const DEFAULT_PAGE_SIZE = 50;

export interface BrowseAssetsParams extends ContentfnClientConfig {
  dataset: string;
  limit?: number;
  offset?: number;
}

/**
 * Fetch one page of assets. Order is deterministic: createdAt desc, then assetId asc.
 */
export async function browseAssets(
  config: BrowseAssetsParams
): Promise<{ ok: true; assets: AssetListItem[] } | { ok: false; code: string; message: string }> {
  const envelope = await listAssets(config, {
    dataset: config.dataset,
    limit: config.limit ?? DEFAULT_PAGE_SIZE,
    offset: config.offset ?? 0,
  });

  if (envelope.ok) {
    return { ok: true, assets: envelope.result.assets };
  }
  return {
    ok: false,
    code: envelope.error.code,
    message: envelope.error.message,
  };
}
