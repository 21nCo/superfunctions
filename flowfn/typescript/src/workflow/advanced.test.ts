import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFlow } from '../core/flow-fn.js';

describe('Advanced Workflow Features', () => {
    let flow;

    beforeEach(() => {
        flow = createFlow({ adapter: 'memory' });
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await flow.close();
        vi.useRealTimers();
    });

    it('should delay until specific time', async () => {
        const targetTime = Date.now() + 1000;
        
        const workflow = flow.workflow('delay-until')
            .step('start', async (ctx) => { ctx.set('step1', Date.now()); })
            .delayUntil(() => targetTime)
            .step('end', async (ctx) => { ctx.set('step2', Date.now()); })
            .build();

        const execution = await workflow.execute({});
        
        // Initial part runs
        await vi.advanceTimersByTimeAsync(10);
        
        // Wait for delay
        await vi.advanceTimersByTimeAsync(1000);
        
        const state = await workflow.getExecution(execution.id);
        expect(state.status).toBe('completed');
        
        const step1Time = state.output.step1;
        const step2Time = state.output.step2;
        
        expect(step2Time).toBeGreaterThanOrEqual(targetTime);
        expect(step2Time - step1Time).toBeGreaterThanOrEqual(1000);
    });
});
