import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisAdapter } from './redis.js';
import { JobImpl } from '../queue/job.js';

// Mock ioredis to return RedisMock
vi.mock('ioredis', async (importOriginal) => {
    const RedisMock = (await import('ioredis-mock')).default;
    return {
        default: RedisMock,
    };
});

describe('RedisAdapter', () => {
    let adapter: RedisAdapter;
    let redis: any;

    beforeEach(async () => {
        const RedisMock = (await import('ioredis-mock')).default;
        redis = new RedisMock();
        
        // Polyfill missing stream commands for ioredis-mock
        redis.xgroup = vi.fn().mockResolvedValue('OK');
        redis.xack = vi.fn().mockResolvedValue(1);
        
        // Mock xreadgroup to behave like xread for testing purposes
        // In reality, it should filter by group/consumer, but for this unit test
        // we just want to verify data flow.
        redis.xreadgroup = vi.fn().mockImplementation(async (cmd, group, consumer, block, ms, count, n, streams, key, id) => {
            // Mapping arguments is tricky because ioredis passes them as varargs
            // The call in adapter is: xreadgroup('GROUP', group, consumer, 'BLOCK', 1000, 'COUNT', 10, 'STREAMS', streamKey, '>')
            // We'll just call xread internally to get data
            // xread('BLOCK', 1000, 'STREAMS', streamKey, '0-0') to get all
            
            // Extract stream key - it's usually near the end
            // The adapter calls it as: .xreadgroup('GROUP', group, consumer, 'BLOCK', 1000, 'COUNT', 10, 'STREAMS', streamKey, '>')
            
            // Simulating a response
            const data = await redis.xread('STREAMS', 'flowfn:stream:group-stream', '0-0');
            return data;
        });

        adapter = new RedisAdapter({ connection: redis });
    });

    afterEach(async () => {
        await adapter.cleanup();
    });

    it('should enqueue and dequeue a job', async () => {
        const job = new JobImpl('test-job', { data: 123 });
        await adapter.enqueue('test-queue', job);
        
        const dequeued = await adapter.dequeue('test-queue');
        expect(dequeued).toBeDefined();
        expect(dequeued!.id).toBe(job.id);
        expect(dequeued!.data).toEqual({ data: 123 });
    });

    it('should handle delayed jobs', async () => {
        const job = new JobImpl('delayed-job', { data: 'late' }, { delay: 1000 });
        await adapter.enqueue('test-queue', job);
        
        // Should be empty initially
        const immediate = await adapter.dequeue('test-queue');
        expect(immediate).toBeNull();

        const delayedKey = 'flowfn:delayed:test-queue';
        const delayedJobs = await redis.zcard(delayedKey);
        expect(delayedJobs).toBe(1);
    });

    it('should publish and subscribe to a stream (XADD/XREAD)', async () => {
        const received: any[] = [];
        await adapter.subscribe('test-stream', async (msg) => {
            received.push(msg);
        });

        const message = { 
            id: '1', 
            stream: 'test-stream', 
            data: { hello: 'world' }, 
            headers: { foo: 'bar' },
            timestamp: Date.now(), 
            ack: async () => {}, 
            nack: async () => {} 
        };
        await adapter.publish('test-stream', message);

        // Wait for polling loop
        await new Promise(r => setTimeout(r, 200));
        expect(received.length).toBeGreaterThan(0);
        expect(received[0].data).toEqual({ hello: 'world' });
        expect(received[0].headers).toEqual({ foo: 'bar' });
    });

    it('should consume via consumer group', async () => {
        const received: any[] = [];
        
        await adapter.consume('group-stream', 'mygroup', 'consumer1', async (msg) => {
            received.push(msg);
            await msg.ack();
        });

        const message = { 
            id: '1', 
            stream: 'group-stream', 
            data: { group: 'test' }, 
            timestamp: Date.now(), 
            ack: async () => {}, 
            nack: async () => {} 
        };
        await adapter.publish('group-stream', message);

        // Wait for polling loop
        await new Promise(r => setTimeout(r, 200));
        
        expect(received.length).toBeGreaterThan(0);
        expect(received[0].data).toEqual({ group: 'test' });
        
        // Verify xgroup/xack called
        expect(redis.xgroup).toHaveBeenCalled();
        expect(redis.xack).toHaveBeenCalled();
    });
});
