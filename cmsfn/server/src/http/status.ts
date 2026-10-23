/**
 * CmsFn GET /cmsfn/status handler.
 * Returns serverTime, capabilities (cmsfn), datasets; verifies ContentFn availability and capabilities.
 */

import { PUBLISH_REPLAY_CAPABILITY } from "../releases/executor.js";
import type { IncomingMessage } from "http";
import type { CmsfnEnvelope, CmsfnStatusResult } from "cmsfn";
import { ok, err } from "cmsfn";
import { fetchContentfnStatus, resolveStatusHeaders, BASE_CAPABILITIES } from "../contentfn/statusClient.js";

/** CmsFn capabilities reported by status. */
const CMSFN_CAPABILITIES = ["cmsfn.status", "cmsfn.studio"] as const;

export interface StatusHandlerConfig {
  /** ContentFn base URL. */
  contentfnBaseUrl: string;
  /** Datasets in config order (names only). */
  datasetNames: string[];
  /** When true, ContentFn must advertise content.realtime. */
  requireRealtime: boolean;
  requirePublishReplay?: boolean;
  /** If set, called for GET /cmsfn/status; true = allow, false = deny. */
  contentfnStatusHeaders?: () => NonNullable<RequestInit['headers']> | Promise<NonNullable<RequestInit['headers']>>;
  authorizeStatus?: (req: IncomingMessage) => Promise<boolean>;
}

/**
 * Handle GET /cmsfn/status.
 * Returns CONTENTFN_UNAVAILABLE when ContentFn is unreachable or missing required capabilities.
 * Returns PERMISSION_DENIED when authorizeStatus returns false.
 */
export async function handleStatus(
  config: StatusHandlerConfig,
  req: IncomingMessage
): Promise<CmsfnEnvelope<CmsfnStatusResult>> {
  try {
    if (config.authorizeStatus && await config.authorizeStatus(req) !== true) return err("PERMISSION_DENIED", "Status endpoint is protected.");
  } catch { return err("PERMISSION_DENIED", "Status endpoint is protected."); }
  let contentfn;
  try { contentfn = await fetchContentfnStatus(config.contentfnBaseUrl, config.requireRealtime, { headers: await resolveStatusHeaders(config.contentfnStatusHeaders), required: [...BASE_CAPABILITIES, ...(config.requireRealtime ? ["content.realtime"] : []), ...(config.requirePublishReplay ? [PUBLISH_REPLAY_CAPABILITY] : [])] }); }
  catch { contentfn = null; }
  if (!contentfn) {
    return err(
      "CONTENTFN_UNAVAILABLE",
      "ContentFn is unreachable or missing required capabilities.",
      {}
    );
  }

  const serverTime = new Date().toISOString();
  return ok({
    serverTime,
    capabilities: [...CMSFN_CAPABILITIES],
    datasets: [...config.datasetNames],
  });
}
