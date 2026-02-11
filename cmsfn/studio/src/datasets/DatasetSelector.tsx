/**
 * Dataset selector: initial value = first config dataset (deterministic).
 * Propagates selected dataset downstream via onDatasetChange.
 */

import type { CmsfnStudioConfig } from "@cmsfn/core";
import { getInitialDataset } from "../config/loadConfig.js";

export interface DatasetSelectorProps {
  config: CmsfnStudioConfig;
  value: string;
  onDatasetChange: (dataset: string) => void;
}

/**
 * Renders a select with configured datasets. Initial value must be set by parent from getInitialDataset(config).
 */
export function DatasetSelector({ config, value, onDatasetChange }: DatasetSelectorProps) {
  const datasets = config.datasets;
  if (datasets.length === 0) return null;
  return (
    <div data-dataset-selector role="group" aria-label="Dataset">
      <label htmlFor="cmsfn-dataset-select">Dataset</label>
      <select
        id="cmsfn-dataset-select"
        data-dataset-select-value={value}
        value={value}
        onChange={(e) => onDatasetChange(e.target.value)}
        aria-label="Select dataset"
      >
        {datasets.map((d) => (
          <option key={d.name} value={d.name}>
            {d.label ?? d.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export { getInitialDataset };
