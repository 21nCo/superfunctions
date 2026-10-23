/**
 * Hook for CFQL list queries: dataset, types, orderBy, limit.
 * nextCursor stored and passed back to ContentFn unchanged (opaque).
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { CfqlQuery, CfqlOrderBy, ContentfnDocument } from "@contentfn/core";
import { queryContentfn } from "../../contentfn/client.js";

const DEFAULT_LIST_LIMIT = 20;

export interface UseCfqlQueryParams {
  baseUrl: string;
  dataset: string;
  perspective?: "published" | "draft";
  types: string[];
  orderBy?: CfqlOrderBy[];
  limit?: number;
}

export interface UseCfqlQueryResult {
  data: ContentfnDocument[];
  nextCursor: string | null;
  loading: boolean;
  error: { code: string; message: string } | null;
  runQuery: () => Promise<void>;
  /** Load next page: passes cursor to ContentFn unchanged (opaque). */
  loadNextPage: (cursor: string) => Promise<void>;
}

export function useCfqlQuery(params: UseCfqlQueryParams): UseCfqlQueryResult {
  const { baseUrl, dataset, perspective = "published", types, orderBy, limit = DEFAULT_LIST_LIMIT } = params;
  const [data, setData] = useState<ContentfnDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const generation = useRef(0);
  useEffect(() => {
    setData([]); setNextCursor(null); setError(null);
    return () => { generation.current++; };
  }, [baseUrl, dataset, perspective, types, orderBy, limit]);

  const runQuery = useCallback(async () => {
    if (!dataset) return;
    const requestGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    const query: CfqlQuery = {
      dataset,
      perspective,
      types: types.length ? types : undefined,
      orderBy: orderBy?.length ? orderBy : undefined,
      limit,
    };
    const envelope = await queryContentfn({ baseUrl }, query);
    if (requestGeneration !== generation.current) return;
    setLoading(false);
    if (envelope.ok) {
      setData(envelope.result.data);
      setNextCursor(envelope.result.nextCursor);
    } else {
      setError({ code: envelope.error.code, message: envelope.error.message });
      setData([]);
      setNextCursor(null);
    }
  }, [baseUrl, dataset, perspective, types, orderBy, limit]);

  const loadNextPage = useCallback(
    async (cursor: string) => {
      if (!dataset) return;
      const requestGeneration = ++generation.current;
      setLoading(true);
      setError(null);
      const query: CfqlQuery = {
        dataset,
        perspective,
        types: types.length ? types : undefined,
        orderBy: orderBy?.length ? orderBy : undefined,
        limit,
        cursor,
      };
      const envelope = await queryContentfn({ baseUrl }, query);
      if (requestGeneration !== generation.current) return;
      setLoading(false);
      if (envelope.ok) {
        setData((prev) => [...prev, ...envelope.result.data]);
        setNextCursor(envelope.result.nextCursor);
      } else {
        setError({ code: envelope.error.code, message: envelope.error.message });
      }
    },
    [baseUrl, dataset, perspective, types, orderBy, limit]
  );

  return {
    data,
    nextCursor,
    loading,
    error,
    runQuery,
    loadNextPage,
  };
}
