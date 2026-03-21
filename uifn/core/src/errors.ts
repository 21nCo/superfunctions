export type UIFnPackageName =
  | '@uifn/core'
  | '@uifn/react'
  | '@uifn/svelte'
  | '@uifn/vue'
  | '@uifn/files';

export const UIFN_ERROR_CODES = [
  'UIFN_ERR_A11Y_GATE_FAILURE',
  'UIFN_ERR_ASCHILD_CONTRACT',
  'UIFN_ERR_COMBOBOX_FILTER_STATE',
  'UIFN_ERR_CONTEXT_MISSING',
  'UIFN_ERR_CONTROLLED_STATE_DIVERGENCE',
  'UIFN_ERR_DETERMINISTIC_ID_MISMATCH',
  'UIFN_ERR_DISABLED_INTERACTION',
  'UIFN_ERR_DOCS_DRIFT',
  'UIFN_ERR_EXPORT_SURFACE_MISMATCH',
  'UIFN_ERR_FILES_SCOPE_DRIFT',
  'UIFN_ERR_HYDRATION_MISMATCH',
  'UIFN_ERR_INVALID_VALUE',
  'UIFN_ERR_MENU_NAVIGATION',
  'UIFN_ERR_PACK_ARTIFACT_LEAK',
  'UIFN_ERR_POSITIONING_OVERFLOW',
  'UIFN_ERR_PUBLIC_SURFACE_DRIFT',
  'UIFN_ERR_RANGE_OUT_OF_BOUNDS',
  'UIFN_ERR_SCROLL_SYNC',
  'UIFN_ERR_SVELTE_REACTIVITY_SNAPSHOT',
  'UIFN_ERR_TEST_MATRIX_GAP',
  'UIFN_ERR_TOOLCHAIN_MISCONFIG',
  'UIFN_ERR_UNSUPPORTED_ENVIRONMENT',
  'UIFN_ERR_UNSUPPORTED_PUBLIC_CLAIM',
] as const;

export type UIFnErrorCode = (typeof UIFN_ERROR_CODES)[number];

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

    this.code = options.code;
    this.package = options.package ?? '@uifn/core';
    this.component = options.component;
    this.details = options.details;
    this.recoverable = options.recoverable ?? false;
    this.cause = options.cause;
  }
}

export function createUIFnError(options: UIFnErrorOptions): UIFnError {
  return new UIFnError(options);
}

export function assertContext<T>(
  value: T | null | undefined,
  options: Omit<UIFnErrorOptions, 'code'> = {}
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

export function runIfEnabled(enabled: boolean, fn: () => void): boolean {
  if (!enabled) {
    return false;
  }

  fn();
  return true;
}
