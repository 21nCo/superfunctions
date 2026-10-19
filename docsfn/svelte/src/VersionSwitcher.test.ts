import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import VersionSwitcher from './VersionSwitcher.svelte';
afterEach(cleanup);
it.each([undefined, { v1: '/docs/v1/guide' }, { v1: '/docs/v1/guide', v2: '/docs/v2/guide' }])('respects explicitly available version routes %j', async versionLinks => {
  const changed = vi.fn();
  const surface = { versions: [{ slug: 'v1', label: 'One' }, { slug: 'v2', label: 'Two' }], currentVersion: 'v1', versionLinks } as any;
  const view = render(VersionSwitcher, { surface, onVersionChange: changed });
  await fireEvent.click(view.getByText('Two'));
  if (versionLinks && !('v2' in versionLinks)) expect(changed).not.toHaveBeenCalled();
  else expect(changed).toHaveBeenCalledWith('v2');
});
it.each([['Enter', true], [' ', true], ['ArrowDown', false]] as const)('activates the highlighted version from the keyboard: %j', async (key, navigates) => {
  const changed = vi.fn();
  const surface = { versions: [{ slug: 'v1', label: 'One' }, { slug: 'v2', label: 'Two' }], currentVersion: 'v1' } as any;
  const view = render(VersionSwitcher, { surface, onVersionChange: changed });
  const content = view.container.querySelector('.docsfn-version-switcher-content')!;
  content.setAttribute('data-active-item', 'v2');
  await fireEvent.keyDown(content, { key });
  if (navigates) expect(changed).toHaveBeenCalledWith('v2');
  else expect(changed).not.toHaveBeenCalled();
});
