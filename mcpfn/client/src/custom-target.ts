import type {
  McpFnTarget,
  McpFnTargetContext,
  McpFnTransportHandle,
} from "./types.js";

export function customTarget(options: {
  kind: string;
  descriptor?: Record<string, unknown>;
  open(context: McpFnTargetContext): Promise<McpFnTransportHandle> | McpFnTransportHandle;
  beginRedactionScope?(): () => void;
  cleanup?(): Promise<void>;
  redact?: NonNullable<McpFnTarget["redact"]>;
  assertArtifactSafe?: NonNullable<McpFnTarget["assertArtifactSafe"]>;
}): McpFnTarget {
  const descriptor = Object.freeze({ kind: options.kind, ...options.descriptor });
  return {
    kind: options.kind,
    describe: () => ({ ...descriptor }),
    open: (context) => Promise.resolve(options.open(context)),
    ...(options.beginRedactionScope
      ? { beginRedactionScope: () => options.beginRedactionScope!() }
      : {}),
    ...(options.cleanup ? { cleanup: () => options.cleanup!() } : {}),
    ...(options.redact ? { redact: options.redact } : {}),
    ...(options.assertArtifactSafe
      ? { assertArtifactSafe: options.assertArtifactSafe }
      : {}),
  };
}
