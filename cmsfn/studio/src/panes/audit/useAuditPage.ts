import { useCallback, useEffect, useRef, useState } from "react";

/** An audit page is scoped to one endpoint, dataset and permission generation. */
export function useAuditPage<T>(baseUrl: string, dataset: string, allowed: boolean, kind: "events" | "webhooks", parse: (value: unknown, dataset: string) => T | null) {
  const scope = JSON.stringify([baseUrl, dataset, allowed, kind]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{ scope: string; rows: T[]; cursor: string | null; loading: boolean; error: string | null; denied: boolean }>({ scope, rows: [], cursor: null, loading: false, error: null, denied: false });
  const load = useCallback(async (cursor?: string | null) => {
    request.current?.abort();
    const token = ++generation.current;
    const controller = new AbortController();
    request.current = controller;
    if (!allowed || !dataset) return;
    setState(old => ({ scope, rows: cursor && old.scope === scope ? old.rows : [], cursor: cursor ?? null, loading: true, error: null, denied: false }));
    const active = () => token === generation.current && currentScope.current === scope && !controller.signal.aborted;
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/cmsfn/audit/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset, limit: 20, ...(cursor ? { cursor } : {}) }), signal: controller.signal });
      const data: unknown = await res.json();
      if (!active()) return;
      if (record(data) && data.ok === false && record(data.error) && data.error.code === "PERMISSION_DENIED") {
        setState({ scope, rows: [], cursor: null, loading: false, error: null, denied: true });
        return;
      }
      if (!res.ok || !record(data) || data.ok !== true || !record(data.result)) throw new Error("Audit request failed");
      const values = data.result[kind === "events" ? "events" : "deliveries"];
      const next = data.result.nextCursor;
      if (!Array.isArray(values) || values.length > 20 || !(next === null || typeof next === "string" && next.length > 0 && next.length <= 2048) || next !== null && next === cursor) throw new Error("Invalid audit response");
      const rows = values.map(value => parse(value, dataset));
      if (rows.some(row => row === null)) throw new Error("Invalid audit response");
      const valid = rows.filter((row): row is T => row !== null);
      setState(old => ({ scope, rows: cursor && old.scope === scope ? [...old.rows, ...valid] : valid, cursor: next, loading: false, error: null, denied: false }));
    } catch {
      if (active()) setState(old => ({ ...old, loading: false, error: "Could not load audit data. Retry the request." }));
    }
  }, [baseUrl, dataset, allowed, kind, parse, scope]);
  useEffect(() => { void load(); return () => { ++generation.current; request.current?.abort(); }; }, [load]);
  const visible = state.scope === scope ? state : { rows: [], cursor: null, loading: true, error: null, denied: false };
  return { ...visible, denied: !allowed || visible.denied, load };
}
export function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
