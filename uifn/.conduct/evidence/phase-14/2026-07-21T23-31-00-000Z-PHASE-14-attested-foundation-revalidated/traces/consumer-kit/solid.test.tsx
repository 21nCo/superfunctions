import { writeFile } from 'node:fs/promises';
import { createComponent, type Component, type JSX } from 'solid-js';
import { Dynamic, render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import manifest from './vectors.json';
import {
  assemblePhase14Trace,
  capturePhase14Checkpoint,
  capturePhase14Cleanup,
  createPhase14HarnessRuntime,
  phase14PartProps,
  runPhase14Actions,
} from './trace.mjs';
import * as UIFnSolid from '@uifn/solid';
type SolidPrimitiveBridge = any;
type SolidPrimitiveRenderPayload = any;

type Vector = (typeof manifest.vectors)[number];
type PublicCompound = Component<Record<string, unknown>> & Record<string, Component<Record<string, unknown>>>;

const disposers: Array<() => void> = [];
const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function elementName(element: string): keyof JSX.IntrinsicElements {
  return (element === 'heading' ? 'h2' : element) as keyof JSX.IntrinsicElements;
}

function compound(name: string): PublicCompound {
  return (UIFnSolid as Record<string, unknown>)[name] as PublicCompound;
}

function publicTree(vector: Vector, runtime: ReturnType<typeof createPhase14HarnessRuntime>, capture: (bridge: SolidPrimitiveBridge) => void): JSX.Element {
  const Compound = compound(vector.primitive);
  const [root, ...parts] = vector.anatomy;
  const Root = Compound[root.component];
  const renderPart = (part: Vector['anatomy'][number], children?: () => JSX.Element) => {
    const Part = Compound[part.component];
    const props = phase14PartProps(vector, part) as Record<string, unknown>;
    if (!voidElements.has(elementName(part.element))) {
      Object.defineProperty(props, 'children', {
        configurable: true,
        enumerable: true,
        get: () => children?.() ?? `${vector.primitive} ${part.component}`,
      });
    }
    return createComponent(Part, props);
  };
  const part = (id: string) => parts.find((candidate) => candidate.id === id)!;
  const children = () => vector.primitive === 'DatePicker'
    ? [
        renderPart(part('label')),
        renderPart(part('input'), () => renderPart(part('segment'))),
        renderPart(part('trigger')),
        renderPart(part('positioner'), () => renderPart(part('content'), () => [
          renderPart(part('header'), () => [renderPart(part('previous')), renderPart(part('next'))]),
          renderPart(part('grid'), () => [
            renderPart(part('gridLabel')),
            <tbody><tr>{renderPart(part('cell'), () => renderPart(part('cellTrigger')))}</tr></tbody>,
          ]),
        ])),
        renderPart(part('hiddenInput')),
      ]
    : parts.map((candidate) => renderPart(candidate));
  const rootProps: Record<string, unknown> = {
    ...runtime.rootProps,
    render: (payload: SolidPrimitiveRenderPayload) => {
      capture(payload.bridge);
      const props = payload.props() as Record<string, unknown>;
      if (!voidElements.has(elementName(root.element))) {
        Object.defineProperty(props, 'children', {
          configurable: true,
          enumerable: true,
          get: children,
        });
      }
      return createComponent(Dynamic as Component<Record<string, unknown>>, {
        component: elementName(root.element),
        ...props,
      });
    },
  };
  return createComponent(Root, rootProps);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  document.body.innerHTML = '';
});

describe('TV-PARITY-001-P: actual Solid public compound traces', () => {
  it('mounts, operates, traces, and cleans every catalog public tree', async () => {
    expect(manifest.primitiveCount).toBe(61);
    expect(manifest.anatomyCount).toBe(419);
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
      document.body.append(host);
      const dispose = render(() => publicTree(vector, runtime, (next) => { bridge = next; }), host);
      await settle();
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
      dispose();
      await settle();
      const cleanup = capturePhase14Cleanup(runtime.token, activeBridge, runtime.scheduler);
      const trace = assemblePhase14Trace({
        vector,
        framework: 'solid',
        frameworkVersion: '1.9.13',
        installMode: (process.env.UIFN_PHASE14_INSTALL_MODE ?? 'source') as 'package' | 'source',
        runtime,
        run,
        cleanup,
      });
      expect(trace.result, `${vector.primitive}:${JSON.stringify({ actions: trace.actions, errors: trace.errors, cleanup })}`).toBe('passed');
      traces.push(trace);
      host.remove();
      document.body.innerHTML = '';
    }

    const output = process.env.UIFN_PHASE14_TRACE_OUT;
    if (output) await writeFile(output, `${JSON.stringify(traces, null, 2)}\n`);
    expect(traces).toHaveLength(61);
  }, 120_000);
});
