import { useEffect, useMemo, useRef, useState } from "react";

import { chartFn, ChartFnAPI, ChartFnConfig, ChartSpec } from "chartfn";

export type UseChartOptions = {
  adapter?: string;
  api?: ChartFnAPI;
  config?: ChartFnConfig;
};

export type UseChartResult = {
  ref: React.RefObject<HTMLDivElement>;
  api?: ChartFnAPI;
  ok: boolean;
  error?: string;
};

export const useChart = (
  spec: ChartSpec,
  options: UseChartOptions = {},
): UseChartResult => {
  const ref = useRef<HTMLDivElement>(null);
  const api = useMemo(() => {
    if (options.api) {
      return options.api;
    }
    if (options.config) {
      return chartFn(options.config);
    }
    return undefined;
  }, [options.api, options.config]);

  const [state, setState] = useState<{ ok: boolean; error?: string }>(
    () => ({ ok: true }),
  );

  const handleRef = useRef<ReturnType<ChartFnAPI["render"]> extends { ok: true; result: infer T } ? T : unknown>();

  useEffect(() => {
    if (!api || !ref.current) {
      return undefined;
    }

    if (handleRef.current) {
      (handleRef.current as { update: (next: ChartSpec) => void }).update(spec);
      return undefined;
    }

    const result = api.render(ref.current, spec, options.adapter ? { adapter: options.adapter } : undefined);
    if (result.ok) {
      handleRef.current = result.result as typeof handleRef.current;
      setState({ ok: true });
    } else {
      setState({ ok: false, error: result.error.message });
    }

    return () => {
      if (handleRef.current) {
        (handleRef.current as { dispose: () => void }).dispose();
        handleRef.current = undefined;
      }
    };
  }, [api, options.adapter, spec]);

  return { ref, api, ok: state.ok, error: state.error };
};
