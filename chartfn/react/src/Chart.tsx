import React from "react";

import { ChartFnAPI, ChartFnConfig, ChartSpec, chartFn } from "chartfn";
import { useChart } from "./useChart.js";

export type ChartProps = {
  spec: ChartSpec;
  adapter?: string;
  api?: ChartFnAPI;
  config?: ChartFnConfig;
  className?: string;
  style?: React.CSSProperties;
};

export const Chart: React.FC<ChartProps> = ({
  spec,
  adapter,
  api,
  config,
  className,
  style,
}) => {
  const resolvedApi = React.useMemo(() => {
    if (api) {
      return api;
    }
    if (config) {
      return chartFn(config);
    }
    return undefined;
  }, [api, config]);

  const { ref } = useChart(spec, { adapter, api: resolvedApi });

  return <div ref={ref} className={className} style={style} />;
};
