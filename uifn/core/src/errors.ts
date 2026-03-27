export type UIFnPackageName =
  | '@uifn/core'
  | '@uifn/react'
  | '@uifn/svelte'
  | '@uifn/vue'
  | '@uifn/files';

const CANONICAL_UIFN_ERROR_CODES = [
  'UIFN_ERR_A11Y_GATE_FAILURE',
  'UIFN_ERR_CONTEXT_MISSING',
  'UIFN_ERR_CONTROLLED_STATE_DIVERGENCE',
  'UIFN_ERR_DETERMINISTIC_ID_MISMATCH',
  'UIFN_ERR_DOCS_DRIFT',
  'UIFN_ERR_DUPLICATE_PUBLIC_ID',
  'UIFN_ERR_EXPORT_SURFACE_MISMATCH',
  'UIFN_ERR_FILES_SCOPE_DRIFT',
  'UIFN_ERR_HYDRATION_MISMATCH',
  'UIFN_ERR_INVALID_VALUE',
  'UIFN_ERR_MANUAL_EVIDENCE_INVALID',
  'UIFN_ERR_MENU_NAVIGATION',
  'UIFN_ERR_PACK_ARTIFACT_LEAK',
  'UIFN_ERR_POSITIONING_OVERFLOW',
  'UIFN_ERR_PUBLIC_SURFACE_DRIFT',
  'UIFN_ERR_RANGE_OUT_OF_BOUNDS',
  'UIFN_ERR_SCROLL_SYNC',
  'UIFN_ERR_TEST_MATRIX_GAP',
  'UIFN_ERR_TOOLCHAIN_MISCONFIG',
  'UIFN_ERR_UNSUPPORTED_ENVIRONMENT',
  'UIFN_ERR_UNSUPPORTED_PUBLIC_CLAIM',
  'UIFN_ERR_WARNING_SUPPRESSED',
  'UIFN_ERR_CONSUMER_SMOKE_FAILURE',
  'UIFN_ERR_DIALOG_MODAL_INCOMPLETE',
] as const;

// Legacy codes still used by existing core primitives until later phases migrate those call sites.
const LEGACY_UIFN_ERROR_CODES = [
  'UIFN_ERR_ASCHILD_CONTRACT',
  'UIFN_ERR_COMBOBOX_FILTER_STATE',
  'UIFN_ERR_DISABLED_INTERACTION',
  'UIFN_ERR_SVELTE_REACTIVITY_SNAPSHOT',
] as const;

export const UIFN_ERROR_CODES = [
  ...CANONICAL_UIFN_ERROR_CODES,
  ...LEGACY_UIFN_ERROR_CODES,
] as const;

export type UIFnErrorCode = (typeof UIFN_ERROR_CODES)[number];

export interface UIFnErrorPayload {
  name: 'UIFnError';
  code: UIFnErrorCode;
  package: UIFnPackageName;
  component?: string;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export interface UIFnErrorOptions {
  code: UIFnErrorCode;
  package?: UIFnPackageName;
  component?: string;
  message?: string;
  details?: Record<string, unknown>;
  recoverable?: boolean;
  cause?: unknown;
}

const DEFAULT_MESSAGES: Partial<Record<UIFnErrorCode, string>> = {
  UIFN_ERR_CONTEXT_MISSING: 'Required UI context is missing.',
  UIFN_ERR_DETERMINISTIC_ID_MISMATCH: 'Public IDs MUST be deterministic across runtimes.',
  UIFN_ERR_DUPLICATE_PUBLIC_ID: 'GA surfaces MUST NOT share fixed instance-scoped IDs.',
  UIFN_ERR_INVALID_VALUE: 'Invalid public value for this surface.',
  UIFN_ERR_RANGE_OUT_OF_BOUNDS: 'Public value is outside the supported range.',
  UIFN_ERR_TOOLCHAIN_MISCONFIG: 'Verification failed due to toolchain misconfiguration.',
  UIFN_ERR_UNSUPPORTED_ENVIRONMENT: 'Unsupported environment matrix for this package.',
};

export class UIFnError extends Error {
  readonly name = 'UIFnError';
  readonly code: UIFnErrorCode;
  readonly package: UIFnPackageName;
  readonly component?: string;
  readonly details?: Record<string, unknown>;
  readonly recoverable: boolean;
  readonly cause?: unknown;

  constructor(options: UIFnErrorOptions) {
    const message = options.message ?? DEFAULT_MESSAGES[options.code] ?? options.code;
    super(message);

    Object.setPrototypeOf(this, new.target.prototype);

    this.code = options.code;
    this.package = options.package ?? '@uifn/core';
    this.component = options.component;
    this.details = options.details;
    this.recoverable = options.recoverable ?? false;
    this.cause = options.cause;
  }

  toJSON(): UIFnErrorPayload {
    return {
      name: this.name,
      code: this.code,
      package: this.package,
      component: this.component,
      message: this.message,
      recoverable: this.recoverable,
      details: this.details,
    };
  }
}

export function createUIFnError(options: UIFnErrorOptions): UIFnError {
  return new UIFnError(options);
}

export function isUIFnError(error: unknown): error is UIFnError {
  return error instanceof UIFnError;
}

export function toUIFnErrorPayload(
  error: unknown,
  fallback: Partial<UIFnErrorOptions> = {}
): UIFnErrorPayload {
  if (isUIFnError(error)) {
    return error.toJSON();
  }

  return createUIFnError({
    code: fallback.code ?? 'UIFN_ERR_TOOLCHAIN_MISCONFIG',
    package: fallback.package ?? '@uifn/core',
    component: fallback.component,
    message:
      fallback.message ??
      (error instanceof Error ? error.message : DEFAULT_MESSAGES.UIFN_ERR_TOOLCHAIN_MISCONFIG),
    details:
      fallback.details ??
      (error instanceof Error
        ? { originalErrorName: error.name }
        : error !== undefined
          ? { originalError: error }
          : undefined),
    recoverable: fallback.recoverable ?? false,
    cause: fallback.cause ?? error,
  }).toJSON();
}

type AssertionOptions = Omit<UIFnErrorOptions, 'code'>;

export function assertContext<T>(
  value: T | null | undefined,
  options: AssertionOptions = {}
): T {
  if (value === null || value === undefined) {
    throw createUIFnError({
      code: 'UIFN_ERR_CONTEXT_MISSING',
      ...options,
      recoverable: options.recoverable ?? false,
    });
  }

  return value;
}

export function assertValidValue(
  condition: boolean,
  options: AssertionOptions = {}
): void {
  if (!condition) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      ...options,
      recoverable: options.recoverable ?? false,
    });
  }
}

export function assertInRange(
  value: number,
  range: { min?: number; max?: number },
  options: AssertionOptions = {}
): number {
  const belowMin = range.min !== undefined && value < range.min;
  const aboveMax = range.max !== undefined && value > range.max;

  if (belowMin || aboveMax) {
    throw createUIFnError({
      code: 'UIFN_ERR_RANGE_OUT_OF_BOUNDS',
      ...options,
      details: {
        value,
        min: range.min,
        max: range.max,
        ...options.details,
      },
      recoverable: options.recoverable ?? false,
    });
  }

  return value;
}

export function runIfEnabled(enabled: boolean, fn: () => void): boolean {
  if (!enabled) {
    return false;
  }

  fn();
  return true;
}
