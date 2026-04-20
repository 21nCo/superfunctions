export const SCHEMA_VERSION = '1.0' as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ErrorEnvelopeShape {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export interface SuccessEnvelope<TData> {
  ok: true;
  schemaVersion: SchemaVersion;
  data: TData;
  warnings: string[];
}

export interface ErrorEnvelope {
  ok: false;
  schemaVersion: SchemaVersion;
  error: ErrorEnvelopeShape;
}

export type ProbefnEnvelope<TData> = SuccessEnvelope<TData> | ErrorEnvelope;

export function createSuccessEnvelope<TData>(
  data: TData,
  warnings: string[] = [],
): SuccessEnvelope<TData> {
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    data,
    warnings,
  };
}

export function createErrorEnvelope(error: ErrorEnvelopeShape): ErrorEnvelope {
  return {
    ok: false,
    schemaVersion: SCHEMA_VERSION,
    error,
  };
}
