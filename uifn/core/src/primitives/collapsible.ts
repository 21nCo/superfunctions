import { createMachine } from '../state/machine';

export type CollapsibleContext = {
  disabled: boolean;
};

export type CollapsibleEvent =
  | { type: 'TOGGLE' }
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'DISABLE' }
  | { type: 'ENABLE' };

export const createCollapsibleMachine = (initialOpen = false, initialDisabled = false) => {
  return createMachine<CollapsibleContext, CollapsibleEvent>({
    initial: initialOpen ? 'open' : 'closed',
    context: {
      disabled: initialDisabled,
    },
    states: {
      closed: {
        on: {
          TOGGLE: { target: 'open', cond: (ctx) => !ctx.disabled },
          OPEN: { target: 'open', cond: (ctx) => !ctx.disabled },
          DISABLE: { actions: [(ctx: CollapsibleContext) => { ctx.disabled = true; }] },
          ENABLE: { actions: [(ctx: CollapsibleContext) => { ctx.disabled = false; }] },
        },
      },
      open: {
        on: {
          TOGGLE: { target: 'closed', cond: (ctx) => !ctx.disabled },
          CLOSE: { target: 'closed', cond: (ctx) => !ctx.disabled },
          DISABLE: { actions: [(ctx: CollapsibleContext) => { ctx.disabled = true; }] },
          ENABLE: { actions: [(ctx: CollapsibleContext) => { ctx.disabled = false; }] },
        },
      },
    },
  });
};
