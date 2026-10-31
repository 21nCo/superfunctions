import type { Options } from 'tsup';
export function bundledInputs(packageRoot: string, outputFormat?: string): { zodRoot: string; plugin: NonNullable<Options['esbuildPlugins']>[number] };
