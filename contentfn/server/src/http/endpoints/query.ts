import type { Adapter } from "@superfunctions/db";
import type { ContentfnEnvelope, CfqlResultPage, CfqlQuery } from "@contentfn/core";
import { executeCfql } from "../../query/executeCfql.js";

export interface QueryEndpointsConfig {
  db: Adapter;
  maxQueryLimit?: number;
}

export async function handleQuery(
  config: QueryEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<CfqlResultPage>> {
  return executeCfql(config, body as CfqlQuery);
}
