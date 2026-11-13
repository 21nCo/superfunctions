import { afterEach, describe, expect, it } from 'vitest';
import { createTabsController, type TabsProps } from '@uifn/core/primitives/tabs';
import catalog from '../../catalog/generated/catalog.json';
import { adapterDomBindings } from '../../../scripts/uifn-adapter-dom-bindings.mjs';
import { SveltePrimitiveBridge, type SveltePrimitiveDefinition } from '../lib/index.js';
import * as publicBindings from '../lib/dom-bindings.js';
import packageJson from '../package.json';

const INSTALLER_NAMES = [
  'overlayDomBinding',
  'menuDomBinding',
  'popupDomBinding',
  'navigationMenuDomBinding',
  'rovingFocusDomBinding',
  'rangeGestureDomBinding',
] as const;

const bridges: SveltePrimitiveBridge<any>[] = [];

afterEach(() => {
  bridges.splice(0).forEach((bridge) => bridge.destroy());
  document.body.replaceChildren();
});

function installerName(installer: unknown): string {
  const name = INSTALLER_NAMES.find((candidate) => publicBindings[candidate] === installer);
  if (!name) throw new Error('svelteDomBindingsFor returned an installer that the subpath does not export.');
  return name;
}

/** A Tabs definition a consumer builds by hand rather than importing the generated `TabsDefinition`. */
function handBuiltTabs(domBindings?: SveltePrimitiveDefinition<TabsProps>['domBindings']): SveltePrimitiveDefinition<TabsProps> {
  return {
    name: 'Tabs',
    family: 'menu-navigation',
    kind: 'interactive-controller',
    rootPart: 'root',
    inputNames: ['value', 'defaultValue', 'items'],
    contextKey: Symbol('consumer.Tabs'),
    createController: createTabsController as never,
    ...(domBindings ? { domBindings } : {}),
  };
}

async function mountTabs(definition: SveltePrimitiveDefinition<TabsProps>) {
  const bridge = new SveltePrimitiveBridge(definition, { defaultValue: 'a', items: ['a', 'b', 'c'] }, { scopeId: 'consumer-tabs' });
  bridges.push(bridge);
  const root = document.createElement('div');
  const triggers = ['a', 'b', 'c'].map((value) => {
    const trigger = document.createElement('button');
    trigger.id = `consumer-tab-${value}`;
    root.append(trigger);
    return trigger;
  });
  document.body.append(root);
  bridge.registerElement('root', undefined, root);
  triggers.forEach((trigger, index) => bridge.registerElement('trigger', ['a', 'b', 'c'][index], trigger));
  const unsubscribe = bridge.subscribe(() => undefined);
  await Promise.resolve();
  triggers[0]!.focus();
  return { bridge, triggers, unsubscribe };
}

async function pressArrowRight(bridge: SveltePrimitiveBridge<any>): Promise<void> {
  (bridge.getActions().handleKeyDown as (key: string, item: string) => void)('ArrowRight', 'a');
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('@uifn/svelte/dom-bindings public subpath', () => {
  it('is a declared package export that resolves ahead of the per-primitive pattern', () => {
    const keys = Object.keys(packageJson.exports);
    expect(packageJson.exports['./dom-bindings']).toMatchObject({ import: './dist/dom-bindings.js', types: './dist/dom-bindings.d.ts' });
    expect(keys.indexOf('./dom-bindings')).toBeLessThan(keys.indexOf('./*'));
    for (const name of INSTALLER_NAMES) expect(typeof publicBindings[name]).toBe('function');
  });

  it('plans the same installers, in the same order, as the generated definitions for every catalog primitive', () => {
    expect(catalog.primitives).toHaveLength(69);
    for (const primitive of catalog.primitives) {
      const planned = publicBindings
        .svelteDomBindingsFor({ name: primitive.name, family: primitive.behaviorFamily })
        .map(installerName);
      expect(planned, primitive.name).toEqual(adapterDomBindings(primitive));
    }
  });

  it('moves roving focus in a hand-built definition that lists the exported installers', async () => {
    const { bridge, triggers } = await mountTabs(handBuiltTabs(publicBindings.svelteDomBindingsFor({ name: 'Tabs', family: 'menu-navigation' })));
    expect(document.activeElement).toBe(triggers[0]);
    await pressArrowRight(bridge);
    expect(bridge.getController()?.getState().focusedItem).toBe('b');
    expect(document.activeElement).toBe(triggers[1]);
  });

  it('wires no roving focus for a hand-built definition without domBindings', async () => {
    const { bridge, triggers } = await mountTabs(handBuiltTabs());
    await pressArrowRight(bridge);
    expect(bridge.getController()?.getState().focusedItem).toBe('b');
    expect(document.activeElement).toBe(triggers[0]);
  });
});
