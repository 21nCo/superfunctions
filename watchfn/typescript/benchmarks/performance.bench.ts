"""
WatchFn Performance Benchmark Suite

Benchmarks core operations to ensure performance targets are met.
"""

import { describe, bench } from 'vitest';
import { MetricAggregator, ContextManager, TimeSeriesDatabase, LogAggregator } from '../src';

describe('MetricAggregator Performance', () => {
  bench('add 1000 metric points', () => {
    const aggregator = new MetricAggregator({
      intervals: ['1m'],
      maxDataPoints: 10000
    });

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      aggregator.add('test.metric', {
        timestamp: now + i,
        value: Math.random() * 100
      });
    }
  });

  bench('query aggregated data', () => {
    const aggregator = new MetricAggregator({
      intervals: ['1m', '5m'],
      maxDataPoints: 10000
    });

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      aggregator.add('test.metric', {
        timestamp: now + i * 1000,
        value: Math.random() * 100
      });
    }

    aggregator.get('test.metric', '1m', now - 60000, now + 60000, 'avg');
  });

  bench('calculate p95 on 1000 points', () => {
    const aggregator = new MetricAggregator({
      intervals: ['1m'],
      maxDataPoints: 10000
    });

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      aggregator.add('test.metric', {
        timestamp: now + i,
        value: Math.random() * 100
      });
    }

    aggregator.get('test.metric', '1m', now - 60000, now + 60000, 'p95');
  });
});

describe('ContextManager Performance', () => {
  bench('context creation and access (sync)', async () => {
    const contextManager = new ContextManager();
    
    await contextManager.run(
      { requestId: 'req_test', userId: 'user_test' },
      () => {
        const ctx = contextManager.get();
        contextManager.setTag('test', 'value');
        const tag = contextManager.getTag('test');
      }
    );
  });

  bench('concurrent context operations', async () => {
    const contextManager = new ContextManager();
    
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        contextManager.run(
          { requestId: `req_${i}` },
          () => {
            contextManager.setTag('index', String(i));
            return contextManager.get();
          }
        )
      )
    );
  });
});

describe('TimeSeriesDatabase Performance', () => {
  bench('write 1000 points', async () => {
    const tsdb = new TimeSeriesDatabase({
      compressionEnabled: false
    });

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      await tsdb.write('test.metric', {
        timestamp: now + i * 1000,
        value: Math.random() * 100
      });
    }
  });

  bench('write 1000 points with compression', async () => {
    const tsdb = new TimeSeriesDatabase({
      compressionEnabled: true,
      compressionThreshold: 100
    });

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      await tsdb.write('test.metric', {
        timestamp: now + i * 1000,
        value: Math.random() * 100
      });
    }
  });

  bench('read 1000 points from time range', async () => {
    const tsdb = new TimeSeriesDatabase();
    const now = Date.now();

    // Setup
    for (let i = 0; i < 1000; i++) {
      await tsdb.write('test.metric', {
        timestamp: now + i * 1000,
        value: Math.random() * 100
      });
    }

    // Benchmark
    await tsdb.read('test.metric', now, now + 1000000);
  });
});

describe('LogAggregator Performance', () => {
  bench('ingest 1000 log entries', () => {
    const aggregator = new LogAggregator({ maxLogs: 100000 });

    for (let i = 0; i < 1000; i++) {
      aggregator.ingest({
        level: 'info',
        message: `Log message ${i}`,
        service: 'test-service'
      });
    }
  });

  bench('query logs with filters', () => {
    const aggregator = new LogAggregator({ maxLogs: 100000 });
    const now = Date.now();

    // Setup
    for (let i = 0; i < 1000; i++) {
      aggregator.ingest({
        level: i % 2 === 0 ? 'info' : 'error',
        message: `Log message ${i}`,
        service: 'test-service'
      });
    }

    // Benchmark
    aggregator.query({
      from: now - 60000,
      to: now + 60000,
      level: ['error'],
      search: 'message',
      limit: 100
    });
  });
});

// Performance targets
console.log(`
Performance Targets:
- MetricAggregator.add: < 1ms per operation
- ContextManager.run: < 0.1ms per operation
- TimeSeriesDatabase.write: < 5ms per operation (without compression)
- LogAggregator.ingest: < 0.5ms per operation
- Query operations: < 100ms for 1000 records
`);
