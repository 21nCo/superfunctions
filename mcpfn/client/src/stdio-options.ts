// Type-only SDK import: this module never loads the stdio transport, so the
// remote entry can share the stdio option and descriptor shape.
import type { StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpFnStdioTargetOptions extends Omit<StdioServerParameters, "command"> {
  command: string;
}

export function stdioTargetDescriptor(
  options: McpFnStdioTargetOptions,
): Record<string, unknown> {
  if (!options.command.trim()) throw new Error("McpFn stdio target command is required");
  return {
    command: options.command,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}
