import { writeFile } from 'node:fs/promises';
import { cleanup, render as renderClient } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import manifest from './vectors.json';
import {
  assemblePhase14Trace,
  capturePhase14Checkpoint,
  capturePhase14Cleanup,
  createPhase14HarnessRuntime,
  runPhase14Actions,
} from './trace.mjs';
import Phase14PublicTreeHarness from './Phase14PublicTreeHarness.svelte';
type SveltePrimitiveBridge = any;

afterEach(() => cleanup());

describe('TV-PARITY-001-P: actual Svelte public compound traces', () => {
  it('mounts, operates, traces, and cleans every catalog public tree', async () => {
    expect(manifest.primitiveCount).toBe(61);
    expect(manifest.anatomyCount).toBe(419);
    const traces: unknown[] = [];

    for (const vector of manifest.vectors) {
      const runtime = createPhase14HarnessRuntime(vector);
      runtime.invokeAction = async (action: (...args: unknown[]) => unknown, args: unknown[], shouldAwait: boolean) => {
        const result = action(...args);
        if (shouldAwait || result instanceof Promise) await result;
        await tick();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await tick();
      };
      let bridge: SveltePrimitiveBridge | undefined;
      const mounted = renderClient(Phase14PublicTreeHarness, {
        props: { vector, rootProps: runtime.rootProps, capture: (next: SveltePrimitiveBridge) => { bridge = next; } },
      });
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tick();
      expect(bridge, `${vector.primitive} public root did not expose its actual bridge`).toBeTruthy();
      const activeBridge = bridge!;
      const run = await runPhase14Actions(
        vector,
        activeBridge,
        runtime,
        (checkpoint: string, sequence: number) => capturePhase14Checkpoint(runtime.token, checkpoint, activeBridge, sequence),
      );
      for (const checkpoint of run.checkpoints) {
        expect(
          checkpoint.parts.parts.map((part: { part: string }) => part.part).sort(),
          `${vector.primitive}:${checkpoint.parts.checkpoint}`,
        ).toEqual(vector.anatomy.map((part) => part.id).sort());
      }
      mounted.unmount();
      await tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cleanupResult = capturePhase14Cleanup(runtime.token, activeBridge, runtime.scheduler);
      const trace = assemblePhase14Trace({
        vector,
        framework: 'svelte',
        frameworkVersion: '5.46.1',
        installMode: (process.env.UIFN_PHASE14_INSTALL_MODE ?? 'source') as 'package' | 'source',
        runtime,
        run,
        cleanup: cleanupResult,
      });
      expect(trace.result, `${vector.primitive}:${JSON.stringify({ actions: trace.actions, errors: trace.errors, cleanup: cleanupResult })}`).toBe('passed');
      traces.push(trace);
      document.body.innerHTML = '';
    }

    const output = process.env.UIFN_PHASE14_TRACE_OUT;
    if (output) await writeFile(output, `${JSON.stringify(traces, null, 2)}\n`);
    expect(traces).toHaveLength(61);
  }, 120_000);
});
