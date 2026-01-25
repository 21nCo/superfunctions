/**
 * Context enrichment pipeline stage
 */

import type { LogEvent, PipelineStage } from "../types.js";

/**
 * Create a context enrichment pipeline stage
 */
export function enrichContext(
  staticFields: Record<string, unknown>,
  dynamic?: () => Record<string, unknown>
): PipelineStage {
  return (event: LogEvent): LogEvent => {
    const dynamicFields = dynamic ? dynamic() : {};

    return {
      ...event,
      ctx: {
        ...staticFields,
        ...dynamicFields,
        ...event.ctx, // Event context overrides enriched fields
      },
    };
  };
}
