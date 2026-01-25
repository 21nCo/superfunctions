import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose, DialogPortal, DialogOverlay } from './dialog';

describe('Dialog (Vue)', () => {
  it('renders and opens via trigger', async () => {
    // We need to mount into a div that exists for Teleport to work if we specify target, 
    // but default is body which exists in JSDOM.
    
    const wrapper = mount({
        components: { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription, DialogClose, DialogPortal, DialogOverlay },
        template: `
            <Dialog>
                <DialogTrigger>Open Dialog</DialogTrigger>
                <DialogPortal>
                    <DialogOverlay />
                    <DialogContent>
                        <DialogTitle>Title</DialogTitle>
                        <DialogDescription>Description</DialogDescription>
                        <DialogClose>Close</DialogClose>
                    </DialogContent>
                </DialogPortal>
            </Dialog>
        `
    }, {
        attachTo: document.body
    });

    expect(document.body.innerHTML).not.toContain('Title');

    await wrapper.find('button').trigger('click');

    expect(document.body.innerHTML).toContain('Title');
    expect(document.body.innerHTML).toContain('Description');
    
    wrapper.unmount();
  });
});
