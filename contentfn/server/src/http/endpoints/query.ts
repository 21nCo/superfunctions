import type { ContentfnDatabase as Adapter } from "../../storage/database.js";
import type { ContentfnEnvelope, CfqlResultPage, CfqlQuery } from "@contentfn/core";
import { executeCfql } from "../../query/executeCfql.js";

export interface QueryEndpointsConfig {
  db: Adapter;
  maxQueryLimit?: number;
  maxExpandDepth?: number;
  maxFilterDepth?: number;
  search?: { enabled: boolean };
}

export async function handleQuery(
  config: QueryEndpointsConfig,
  body: unknown
): Promise<ContentfnEnvelope<CfqlResultPage>> {
  return executeCfql(config, body as CfqlQuery);
}
