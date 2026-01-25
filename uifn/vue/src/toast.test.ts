import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import { ToastProvider, Toast, ToastTitle, ToastDescription, ToastClose, ToastViewport } from './toast';

describe('Toast (Vue)', () => {
  it('renders and closes automatically', async () => {
    vi.useFakeTimers();

    const wrapper = mount(ToastProvider, {
      slots: {
        default: () => [
          h(Toast, { defaultOpen: true, duration: 1000 }, () => [
            h(ToastTitle, () => 'Toast Title'),
            h(ToastClose, () => 'Close')
          ]),
          h(ToastViewport)
        ]
      },
      attachTo: document.body
    });

    // Viewport is teleported to body
    expect(document.body.innerHTML).toContain('Toast Title');

    vi.advanceTimersByTime(1000);
    await wrapper.vm.$nextTick();

    expect(document.body.innerHTML).not.toContain('Toast Title');

    vi.useRealTimers();
  });

  it('closes via close button', async () => {
    const wrapper = mount(ToastProvider, {
      slots: {
        default: () => [
          h(Toast, { defaultOpen: true }, () => [
             h(ToastTitle, () => 'Toast Title'),
             h(ToastClose, () => 'Close')
          ]),
          h(ToastViewport)
        ]
      },
      attachTo: document.body
    });
    
    expect(document.body.innerHTML).toContain('Toast Title');
    
    // Find button inside portal... tricky with wrapper.find().
    // We query document.
    const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Close');
    if (closeBtn) {
        closeBtn.click();
    }
    
    await wrapper.vm.$nextTick();
    expect(document.body.innerHTML).not.toContain('Toast Title');
  });
});
