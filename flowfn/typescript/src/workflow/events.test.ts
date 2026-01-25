import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFlow } from '../core/flow-fn.js';

describe('Workflow Events', () => {
    let flow;

    beforeEach(() => {
        flow = createFlow({ adapter: 'memory' });
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await flow.close();
        vi.useRealTimers();
    });

    it('should wait for event (timeout simulation)', async () => {
        const workflow = flow.workflow('wait-event')
            .step('start', async (ctx) => { ctx.set('started', true); })
            .waitForEvent('user.signup', { timeout: 1000 })
            .step('end', async (ctx) => { ctx.set('ended', true); })
            .build();

        const execution = await workflow.execute({});
        
        // Start
        await vi.advanceTimersByTimeAsync(10);
        
        // Check intermediate state if possible (not easily exposed yet)
        
        // Wait for timeout
        await vi.advanceTimersByTimeAsync(1000);
        
        const state = await workflow.getExecution(execution.id);
        expect(state.status).toBe('completed');
        expect(state.output.started).toBe(true);
        expect(state.output.ended).toBe(true);
    });
});
