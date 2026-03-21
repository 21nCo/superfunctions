import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { Checkbox } from './checkbox';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

function SsrFixture() {
  return (
    <div>
      <Dialog defaultOpen>
        <DialogTrigger>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>SSR Dialog</DialogTitle>
        </DialogContent>
      </Dialog>
      <Tabs defaultValue="tab-1">
        <TabsList>
          <TabsTrigger value="tab-1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab-2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab-1">Panel 1</TabsContent>
        <TabsContent value="tab-2">Panel 2</TabsContent>
      </Tabs>
      <Checkbox defaultChecked={false} aria-label="SSR Checkbox" />
    </div>
  );
}

describe('SSR and hydration smoke', () => {
  it('hydrates Dialog, Tabs, and Checkbox without mismatch warnings', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const html = renderToString(<SsrFixture />);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    await React.act(async () => {
      hydrateRoot(container, <SsrFixture />);
      await Promise.resolve();
    });

    const hydrationErrors = errorSpy.mock.calls.filter(([message]) => {
      return (
        typeof message === 'string' &&
        !message.includes('useLayoutEffect does nothing on the server')
      );
    });
    expect(hydrationErrors).toHaveLength(0);

    errorSpy.mockRestore();
    document.body.removeChild(container);
  });
});
