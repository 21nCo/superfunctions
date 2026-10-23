import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
        scheduler = new Scheduler();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        await scheduler.close();
        vi.useRealTimers();
    });

    it('should schedule a task using cron pattern', async () => {
        let count = 0;
        // Every second
        await scheduler.schedule('test', '* * * * * *', async () => {
            count++;
        });

        const list = await scheduler.list();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('test');

        await vi.advanceTimersByTimeAsync(1000);
        expect(count).toBe(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(count).toBe(2);
    });

    it('should schedule a task using "every" interval', async () => {
        let count = 0;
        await scheduler.schedule('repeat', { every: 100 }, async () => {
            count++;
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(count).toBe(1);

        await vi.advanceTimersByTimeAsync(100);
        expect(count).toBe(2);
    });

    it('should respect limits', async () => {
        let count = 0;
        await scheduler.schedule('limited', { every: 100, limit: 2 }, async () => {
            count++;
        });

        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(100);
        
        expect(count).toBe(2);
        const list = await scheduler.list();
        expect(list).toHaveLength(0);
    });

    it('should pause and resume', async () => {
        let count = 0;
        await scheduler.schedule('pause-test', { every: 100 }, async () => {
            count++;
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(count).toBe(1);

        await scheduler.pause('pause-test');
        await vi.advanceTimersByTimeAsync(100);
        expect(count).toBe(1);

        await scheduler.resume('pause-test');
        await vi.advanceTimersByTimeAsync(100);
        expect(count).toBe(2);
    });
});
