import { writeFile } from 'node:fs/promises';
import * as React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import manifest from './vectors.json';
import { createPhase14HarnessRuntime, phase14PartProps } from './trace.mjs';
import * as UIFnReact from '@uifn/react';
type ReactPrimitiveBridge = any;
type ReactPrimitiveRenderPayload = any;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    return React.createElement(Part, props, voidElements.has(elementName(part.element)) ? undefined : (children ?? `${vector.primitive} ${part.component}`));
  };
  const part = (id: string) => parts.find((candidate) => candidate.id === id)!;
  const children = vector.primitive === 'DatePicker'
    ? [
        renderPart(part('label')),
        renderPart(part('input'), renderPart(part('segment'))),
        renderPart(part('trigger')),
        renderPart(part('positioner'), renderPart(part('content'), [
          renderPart(part('header'), [renderPart(part('previous')), renderPart(part('next'))]),
          renderPart(part('grid'), [
            renderPart(part('gridLabel')),
            React.createElement('tbody', { key: 'date-picker-body' }, React.createElement('tr', null, renderPart(part('cell'), renderPart(part('cellTrigger'))))),
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

describe('TV-REACT-001-P: packed all-compound SSR and hydration', () => {
  it('server-renders and hydrates every public compound without mismatch or duplicate IDs', async () => {
    expect(manifest.primitiveCount).toBe(61);
    const observations: Array<Record<string, unknown>> = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const vector of manifest.vectors) {
        const runtime = createPhase14HarnessRuntime(vector);
        let bridge: ReactPrimitiveBridge | undefined;
        const tree = publicTree(vector, runtime, (next) => { bridge = next; });
        const errorStart = consoleError.mock.calls.length;
        const html = renderToString(tree);
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.append(host);
        const beforeIds = Array.from(host.querySelectorAll<HTMLElement>('[id]')).map((element) => element.id);
        expect(new Set(beforeIds).size, `${vector.primitive} server IDs`).toBe(beforeIds.length);
        let root: ReturnType<typeof hydrateRoot> | undefined;
        await React.act(async () => {
          root = hydrateRoot(host, tree);
          await Promise.resolve();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const renderErrors = consoleError.mock.calls.slice(errorStart);
        expect(renderErrors, `${vector.primitive} SSR/hydration warnings`).toHaveLength(0);
        expect(bridge, `${vector.primitive} hydrated bridge`).toBeTruthy();
        const afterIds = Array.from(host.querySelectorAll<HTMLElement>('[id]')).map((element) => element.id);
        expect(new Set(afterIds).size, `${vector.primitive} hydrated IDs`).toBe(afterIds.length);
        await React.act(async () => {
          root?.unmount();
          await Promise.resolve();
        });
        host.remove();
        document.body.innerHTML = '';
        observations.push({ primitive: vector.primitive, framework: 'react', frameworkVersion: React.version, installMode: process.env.UIFN_PHASE14_INSTALL_MODE ?? 'source', result: 'passed' });
      }
    } finally {
      consoleError.mockRestore();
    }
    const output = process.env.UIFN_PHASE14_TRACE_OUT;
    if (output) await writeFile(output, `${JSON.stringify(observations, null, 2)}\n`);
    expect(observations).toHaveLength(61);
  }, 120_000);
});
