import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgresAdapter } from './index.js';
import { JobImpl } from '../../queue/job.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { jobs, messages, workflowExecutions } from './schema.js';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// We need to verify compatibility. PostgresAdapter uses Postgres specific SQL (SKIP LOCKED).
// Testing with SQLite won't work for enqueue/dequeue if we use raw SQL SKIP LOCKED.
// However, for unit testing logic without a real Postgres, we might need to mock db.execute 
// OR implement a fallback in the adapter for non-Postgres (which we kind of did but with raw SQL).

// Since we can't easily spin up Postgres in this environment without docker, 
// and the adapter has hardcoded Postgres SQL for dequeue, 
// we will Mock the DB instance.

describe('PostgresAdapter', () => {
    let adapter: PostgresAdapter;
    let mockDb: any;

    beforeEach(() => {
        mockDb = {
            insert: () => ({ values: () => Promise.resolve() }), // mock insert
            update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
            select: () => ({ from: () => ({ where: () => ({ groupBy: () => Promise.resolve([]), orderBy: () => ({ limit: () => Promise.resolve([]) }) }), limit: () => Promise.resolve([]) }) }), // mock select chain
            transaction: async (cb: any) => cb(mockDb),
            execute: async () => [],
        };
        adapter = new PostgresAdapter({ db: mockDb });
    });

    it('should enqueue a job', async () => {
        // Just verify it calls insert
        let inserted = false;
        mockDb.insert = (table) => {
            return {
                values: (vals) => {
                    inserted = true;
                    expect(vals.queue).toBe('test-queue');
                    return Promise.resolve();
                }
            };
        };
        
        const job = new JobImpl('test-job', { data: 123 });
        await adapter.enqueue('test-queue', job);
        expect(inserted).toBe(true);
    });

    it('should dequeue a job (simulated)', async () => {
        // Mock execute to return a job
        mockDb.execute = async (query) => {
            // Check if it's the dequeue query
            // Drizzle sql`` returns an object with sql/params or just strings array
            // The exact structure depends on implementation but for mocking we check what we get
            const sqlStr = query.sql || (query.strings ? query.strings.join('') : String(query));
            
            if (sqlStr.includes('UPDATE flowfn_jobs') || JSON.stringify(query).includes('UPDATE flowfn_jobs')) {
                return [{
                    id: 'job-1',
                    queue: 'test-queue',
                    name: 'test-job',
                    data: { data: 123 },
                    opts: {},
                    state: 'active',
                    timestamp: Date.now()
                }];
            }
            return [];
        };

        const job = await adapter.dequeue('test-queue');
        expect(job).toBeDefined();
        expect(job!.id).toBe('job-1');
    });

    it('should save workflow state', async () => {
        let upserted = false;
        mockDb.insert = () => ({
            values: (v) => ({
                onConflictDoUpdate: (opts) => {
                    upserted = true;
                    return Promise.resolve();
                }
            })
        });

        await adapter.saveWorkflowState('wf-1', {
            id: 'exec-1',
            workflowId: 'wf-1',
            status: 'running',
            startedAt: Date.now()
        });
        
        expect(upserted).toBe(true);
    });
});
