import { render } from 'solid-js/web';
import manifest from './vectors.json';
import {
  assemblePhase14Trace,
  capturePhase14Checkpoint,
  capturePhase14Cleanup,
  createPhase14HarnessRuntime,
  runPhase14Actions,
} from './trace.mjs';
type SolidPrimitiveBridge = any;
import { createPhase14SolidPublicTree } from './Phase14SolidPublicTree';
import { assertPhase14Checkpoints, assertUniqueIds, browserTraceEnvironment, removeHarnessDom, settle } from './browser-runtime';

const frameworkVersion = '1.9.13';

export async function runBrowserPublicTrees(): Promise<unknown[]> {
  const traces: unknown[] = [];
  for (const vector of manifest.vectors) {
    const runtime = createPhase14HarnessRuntime(vector);
    runtime.invokeAction = async (action: (...args: unknown[]) => unknown, args: unknown[], shouldAwait: boolean) => {
      const result = action(...args);
      if (shouldAwait || result instanceof Promise) await result;
      await settle();
    };
    let bridge: SolidPrimitiveBridge | undefined;
    const host = document.createElement('div');
    host.dataset.uifnPhase14BrowserHost = vector.id;
    document.body.append(host);
    const dispose = render(() => createPhase14SolidPublicTree(vector, runtime, (next) => { bridge = next; }), host);
    await settle();
    if (!bridge) throw new Error(`${vector.primitive} public root did not expose its Solid bridge in a real browser.`);
    const activeBridge = bridge;
    assertUniqueIds(vector);
    const run = await runPhase14Actions(
      vector,
      activeBridge,
      runtime,
      (checkpoint: string, sequence: number) => capturePhase14Checkpoint(runtime.token, checkpoint, activeBridge, sequence),
    );
    assertPhase14Checkpoints(vector, run.checkpoints);
    dispose();
    await settle();
    const cleanup = capturePhase14Cleanup(runtime.token, activeBridge, runtime.scheduler);
    const trace = assemblePhase14Trace({
      vector,
      framework: 'solid',
      frameworkVersion,
      installMode: 'package',
      runtime,
      run,
      cleanup,
      environment: browserTraceEnvironment(),
    });
    if (trace.result !== 'passed') throw new Error(`${vector.primitive} Solid browser trace failed: ${JSON.stringify({ actions: trace.actions, errors: trace.errors, cleanup })}`);
    traces.push(trace);
    removeHarnessDom();
  }
  if (traces.length !== 61) throw new Error(`Solid browser harness produced ${traces.length}/61 public-tree traces.`);
  return traces;
}
