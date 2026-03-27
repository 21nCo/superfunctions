import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Tabs', () => {
  it('automatically activates tabs for arrow, home, and end navigation', async () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
          <TabsTrigger value="tab3">Tab 3</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
        <TabsContent value="tab3">Content 3</TabsContent>
      </Tabs>
    );

    const tab1 = screen.getByRole('tab', { name: 'Tab 1' });
    const tab2 = screen.getByRole('tab', { name: 'Tab 2' });
    const tab3 = screen.getByRole('tab', { name: 'Tab 3' });

    tab1.focus();
    fireEvent.keyDown(tab1, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(tab2).toHaveFocus();
      expect(screen.getByText('Content 2')).toBeVisible();
    });

    fireEvent.keyDown(tab2, { key: 'End' });

    await waitFor(() => {
      expect(tab3).toHaveFocus();
      expect(screen.getByText('Content 3')).toBeVisible();
    });

    fireEvent.keyDown(tab3, { key: 'Home' });

    await waitFor(() => {
      expect(tab1).toHaveFocus();
      expect(screen.getByText('Content 1')).toBeVisible();
    });
  });

  it('keeps manual activation focused without changing the active panel until selection', async () => {
    render(
      <Tabs defaultValue="tab1" activationMode="manual">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );

    const tab1 = screen.getByRole('tab', { name: 'Tab 1' });
    const tab2 = screen.getByRole('tab', { name: 'Tab 2' });

    tab1.focus();
    fireEvent.keyDown(tab1, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(tab2).toHaveFocus();
    });

    expect(screen.getByText('Content 1')).toBeVisible();
    expect(screen.queryByText('Content 2')).not.toBeInTheDocument();

    fireEvent.click(tab2);

    expect(screen.getByText('Content 2')).toBeVisible();
  });
});
