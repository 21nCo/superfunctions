import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { FlowAdapter } from '../adapters/base.js';
import { createFlow } from '../core/flow-fn.js';

export async function telemetryContract(adapter: FlowAdapter) {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const binding = new Proxy(adapter, { get(target, key) { const value = Reflect.get(target, key); return key === 'cleanup' ? async () => {} : typeof value === 'function' ? value.bind(target) : value; } });
  const errors: string[] = [];
  const flow = createFlow({ adapter: binding, namespace: randomUUID(), telemetry: { enabled: true, provider: 'custom', tracer: provider.getTracer('native-acceptance') }, onError: (_error, info) => { errors.push(info.operation); } });
  try {
    const queue = flow.queue('traced');
    queue.process(async job => {
      const span = trace.getActiveSpan();
      expect(span).toBeDefined();
      await queue.getJobCounts();
      expect(trace.getActiveSpan()).toBe(span);
      if (job.name === 'failure') throw new Error('expected native callback failure');
      return 7;
    });
    const success = await queue.add('success', { secret: 'never-export' });
    const failure = await queue.add('failure', {});
    await queue.drain();
    expect((await queue.getJob(success.id))?.returnvalue).toBe(7);
    expect((await queue.getJob(failure.id))?.state).toBe('failed');
    const workflow = flow.workflow('traced').step('work', async () => { expect(trace.getActiveSpan()).toBeDefined(); return 9; }).build();
    const execution = await workflow.execute({ secret: 'never-export' });
    expect((await workflow.waitForCompletion(execution.id)).output).toBe(9);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const job = spans.find(span => span.name === 'flowfn.job.execute' && span.attributes['flowfn.job.id'] === success.id)!;
    expect(spans.some(span => span.name === 'flowfn.adapter.getQueueStats' && span.parentSpanContext?.spanId === job.spanContext().spanId)).toBe(true);
    expect(spans.some(span => span.name === 'flowfn.job.execute' && span.status.code === SpanStatusCode.ERROR)).toBe(true);
    expect(spans.some(span => span.name === 'flowfn.workflow.step')).toBe(true);
    expect(errors).toContain('flowfn.job.execute');
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain('never-export');
  } finally { await flow.close(); await provider.shutdown(); context.disable(); }
}
