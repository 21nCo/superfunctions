import { afterEach, describe, expect, it, vi } from 'vitest';
import { MenubarDefinition } from '../lib/generated/menubar/definition.js';
import { TabsDefinition } from '../lib/generated/tabs/definition.js';
import { svelteMenubarCommitFocus } from '../lib/dom-bindings.js';

// The bridge runs Menubar's post-commit focus only through the definition's commitFocus hook, never by name.
function harness(initial: Record<string, unknown>) {
  let state = initial;
  const elements = new Map<string, HTMLElement>();
  const button = (key: string) => {
    const element = document.createElement('button');
    document.body.append(element);
    elements.set(key, element);
    return element;
  };
  const root = document.createElement('div');
  document.body.append(root);
  elements.set('root:', root);
  const bridge = {
    definition: MenubarDefinition,
    getElement: (part: string, value?: unknown) => elements.get(`${part}:${value === undefined ? '' : String(value)}`) ?? null,
    getElementEntries: () => [],
  };
  const controller = { getState: () => state };
  const handle = svelteMenubarCommitFocus(bridge as never, controller as never);
  return { handle, button, setState: (next: Record<string, unknown>) => { state = next; } };
}

describe('Svelte Menubar commit focus', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('is listed only by the generated Menubar definition', () => {
    expect(MenubarDefinition.commitFocus).toBe(svelteMenubarCommitFocus);
    expect(TabsDefinition).not.toHaveProperty('commitFocus');
  });

  it('focuses the active item after the next frame, then restores the menu trigger on close', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { handle, button, setState } = harness({ value: '', focusedMenu: 'file' });
    const trigger = button('trigger:file');
    const item = button('item:open');
    setState({ value: 'file', activeItem: 'open', focusedMenu: 'file' });
    handle.changed();
    expect(document.activeElement).not.toBe(item);
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(item);
    setState({ value: '', focusReturn: 'file', focusedMenu: 'file' });
    handle.changed();
    vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(trigger);
  });

  it('focuses the open active item once a DOM commit lands, and does nothing after destroy', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    const { handle, button, setState } = harness({ value: '', focusedMenu: 'file' });
    const item = button('item:open');
    setState({ value: 'file', activeItem: 'open' });
    handle.committed();
    expect(document.activeElement).toBe(item);
    item.blur();
    handle.changed();
    handle.destroy();
    vi.advanceTimersToNextFrame();
    handle.committed();
    expect(document.activeElement).not.toBe(item);
  });
});
