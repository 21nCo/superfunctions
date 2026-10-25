export * from "./core/types";
export * from "./core/watch-fn";
export * from "./core/event-router";
export * from "./collectors/errors/exception-handler";
export * from "./collectors/errors/breadcrumbs";
export * from "./collectors/apm/http-interceptor";
export * from "./http/handlers";
export * from "./http/router";
export * from "./synthetics/scheduler";

export * from "./trace/span";
export * from "./trace/tracer";
export * from "./alerts/alert-manager";
export * from "./query/types";
export * from "./query/query-engine";
export * from "./storage/types";
export * from "./storage/database";
export * from "./collectors/infra/system-metrics";
export * from "./collectors/infra/process-metrics";
export * from "./synthetics/types";
export * from "./synthetics/scheduler";
export * from "./synthetics/monitor";

// Core
export * from "./core/metric-aggregator";
export * from "./core/context-manager";

// Query
export * from "./query/aggregations";
export * from "./query/filters";
export {
  TimeRangeParser,
  type AbsoluteTimeRange,
  type TimeRangeShortcut,
  type TimeRange as ParsedTimeRange,
} from "./query/time-range";

// Utils
export * from "./utils/sampling";
export * from "./utils/compression";

// Storage
export * from "./storage/time-series/index";
export {
  TimeSeriesAggregator,
  type AggregatedPoint,
  type AggregationFunc,
  type AggregationConfig as TimeSeriesAggregationConfig,
} from "./storage/time-series/aggregation";
export * from "./storage/time-series/retention";
export * from "./storage/events/index";

// Framework integrations are available through ./adapters/* subpaths.

// APM
export * from "./collectors/apm/database-tracer";
export * from "./collectors/apm/function-profiler";

// Errors
export * from "./collectors/errors/source-maps";

// RUM
export * from "./collectors/rum/page-load";
export * from "./collectors/rum/user-interactions";

// Trace
export * from "./trace/context-propagation";

// Alerts
export {
  ConditionEvaluator,
  type AlertMetricPoint,
  type AlertMetricData,
  type ConditionResult,
  type AnomalyCondition,
  type CompositeCondition,
  type ConditionOperator,
  type ThresholdCondition,
  type AlertCondition as EvaluatedAlertCondition,
} from "./alerts/conditions";
export * from "./alerts/evaluator";
export * from "./alerts/channels/slack";
export * from "./alerts/channels/webhook";
export * from "./alerts/channels/email";

// Business
export * from "./business/metrics-tracker";

// Analysis
export * from "./analysis/anomaly-detection";

// Public names let downstream libraries emit portable inferred declarations.
export type { Router } from "@superfunctions/http";
export type { TableSchema } from "@superfunctions/db";

export type { DeploymentComparisonOptions, ComparedMetric } from "./analysis/deployment-comparison";

export type { BotFnIssueConfig, BotFnIssueRoute, BotFnGitHubClient, BotFnLinearClient, BugIssueStatus, BugReportReference } from "./integrations/botfn/types";
export { getBugIssueSchema } from "./integrations/botfn/schema";
export { BugIssueConflictError, BugIssueValidationError } from "./integrations/botfn/types";

export { getAlertSchema } from './alerts/schema';
export { AlertManager } from './alerts/alert-manager';
export type { AlertConfig, AlertChannel, AlertRuntimeConfig, AlertEmailConfig, AlertSender, AlertNotification, PublicAlert, AlertLifecycleContext, AlertLifecycleListener } from './alerts/types';
