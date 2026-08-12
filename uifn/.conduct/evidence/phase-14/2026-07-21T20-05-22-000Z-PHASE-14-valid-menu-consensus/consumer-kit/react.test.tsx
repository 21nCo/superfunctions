import { writeFile } from 'node:fs/promises';
import * as React from 'react';
import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import manifest from './vectors.json';
import {
  assemblePhase14Trace,
  capturePhase14Checkpoint,
  capturePhase14Cleanup,
  createPhase14HarnessRuntime,
  phase14PartProps,
  runPhase14Actions,
} from './trace.mjs';
import * as UIFnReact from '@uifn/react';
type ReactPrimitiveBridge = any;
type ReactPrimitiveRenderPayload = any;

type Vector = (typeof manifest.vectors)[number];
type PublicCompound = React.ElementType & Record<string, React.ElementType>;

const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function elementName(element: string): keyof React.JSX.IntrinsicElements {
  return (element === 'heading' ? 'h2' : element) as keyof React.JSX.IntrinsicElements;
}

function compound(name: string): PublicCompound {
  return (UIFnReact as Record<string, unknown>)[name] as PublicCompound;
}

function publicTree(vector: Vector, runtime: ReturnType<typeof createPhase14HarnessRuntime>, capture: (bridge: ReactPrimitiveBridge) => void): React.ReactElement {
  const Compound = compound(vector.primitive);
  const [root, ...parts] = vector.anatomy;
  const Root = Compound[root.component];
  const renderPart = (part: Vector['anatomy'][number], children?: React.ReactNode) => {
    const Part = Compound[part.component];
    const props: Record<string, unknown> = {
      key: `${part.id}:${String('value' in part ? part.value : 'one')}`,
      ...phase14PartProps(vector, part),
    };
    return React.createElement(
      Part,
      props,
      voidElements.has(elementName(part.element)) ? undefined : (children ?? `${vector.primitive} ${part.component}`),
    );
  };
  const part = (id: string) => parts.find((candidate) => candidate.id === id)!;
  const menuChildren = () => [
    renderPart(part('trigger')),
    renderPart(part('positioner'), renderPart(part('content'), [
      renderPart(part('item'), renderPart(part('itemIndicator'))),
      renderPart(part('separator')),
      renderPart(part('group'), renderPart(part('groupLabel'))),
      renderPart(part('submenuTrigger')),
      renderPart(part('submenuContent')),
    ])),
  ];
  const children = ['Menu', 'ContextMenu'].includes(vector.primitive)
    ? menuChildren()
    : vector.primitive === 'DatePicker'
    ? [
        renderPart(part('label')),
        renderPart(part('input'), renderPart(part('segment'))),
        renderPart(part('trigger')),
        renderPart(part('positioner'), renderPart(part('content'), [
          renderPart(part('header'), [renderPart(part('previous')), renderPart(part('next'))]),
          renderPart(part('grid'), [
            renderPart(part('gridLabel')),
            React.createElement('tbody', { key: 'date-picker-body' },
              React.createElement('tr', null, renderPart(part('cell'), renderPart(part('cellTrigger'))))),
          ]),
        ])),
        renderPart(part('hiddenInput')),
      ]
    : parts.map((candidate) => renderPart(candidate));
  const renderRoot = (payload: ReactPrimitiveRenderPayload) => {
    capture(payload.bridge);
    return React.createElement(elementName(root.element), payload.props);
  };
  return React.createElement(Root, { ...runtime.rootProps, render: renderRoot }, children.length ? children : undefined);
}

describe('TV-PARITY-001-P: actual React public compound traces', () => {
  it('mounts, operates, traces, and cleans every catalog public tree', async () => {
    expect(manifest.primitiveCount).toBe(61);
    expect(manifest.anatomyCount).toBe(419);
    const traces: unknown[] = [];
    let currentPrimitive = 'unstarted';

    try {
      for (const vector of manifest.vectors) {
      currentPrimitive = vector.primitive;
      const runtime = createPhase14HarnessRuntime(vector);
      runtime.invokeAction = async (action: (...args: unknown[]) => unknown, args: unknown[], shouldAwait: boolean) => {
        await act(async () => {
          const result = action(...args);
          if (shouldAwait || result instanceof Promise) await result;
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
      let bridge: ReactPrimitiveBridge | undefined;
      const tree = publicTree(vector, runtime, (next) => { bridge = next; });
      const mounted = render(
        process.env.UIFN_PHASE14_REACT_STRICT === '1'
          ? <React.StrictMode>{tree}</React.StrictMode>
          : tree,
      );
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      const cleanup = capturePhase14Cleanup(runtime.token, activeBridge, runtime.scheduler);
      const trace = assemblePhase14Trace({
        vector,
        framework: 'react',
        frameworkVersion: React.version,
        installMode: (process.env.UIFN_PHASE14_INSTALL_MODE ?? 'source') as 'package' | 'source',
        runtime,
        run,
        cleanup,
      });
      expect(trace.result, `${vector.primitive}:${JSON.stringify({ actions: trace.actions, errors: trace.errors, cleanup })}`).toBe('passed');
      traces.push(trace);
      document.body.innerHTML = '';
      }
    } catch (error) {
      throw new Error(`Phase 14 React public vector failed for ${currentPrimitive}.`, { cause: error });
    }

    const output = process.env.UIFN_PHASE14_TRACE_OUT;
    if (output) await writeFile(output, `${JSON.stringify(traces, null, 2)}\n`);
    expect(traces).toHaveLength(61);
  }, 120_000);
});
