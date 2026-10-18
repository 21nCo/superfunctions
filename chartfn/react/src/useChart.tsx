import { useEffect, useMemo, useRef, useState } from "react";

import { chartFn, ChartFnAPI, ChartFnConfig, ChartSpec, ChartAdapterHandle } from "chartfn";

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

  const binding = useRef<{ api: ChartFnAPI; adapter?: string; handle: ChartAdapterHandle; spec: ChartSpec }>();

  useEffect(() => {
    const current = binding.current;
    if (current && (current.api !== api || current.adapter !== options.adapter)) {
      current.handle.dispose();
      binding.current = undefined;
    }
    if (!api || !ref.current) return;
    if (binding.current) {
      if (binding.current.spec === spec) return;
      try {
        binding.current.handle.update(spec);
        binding.current.spec = spec;
        setState({ ok: true });
      } catch (error) {
        setState({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const result = api.render(ref.current, spec, options.adapter ? { adapter: options.adapter } : undefined);
    if (result.ok) {
      binding.current = { api, adapter: options.adapter, handle: result.result, spec };
      setState({ ok: true });
    } else {
      setState({ ok: false, error: result.error.message });
    }
  }, [api, options.adapter, spec]);

  useEffect(() => () => {
    binding.current?.handle.dispose();
    binding.current = undefined;
  }, []);

  return { ref, api, ok: state.ok, error: state.error };
};
