import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { context, trace, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { FlowInstrumentation, OperationObserver } from './instrumentation.js';
import { createFlow } from './core/flow-fn.js';
import { MemoryAdapter } from './adapters/memory.js';
let provider: BasicTracerProvider, exporter: InMemorySpanExporter;
beforeEach(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
});
afterEach(async () => { await provider.shutdown(); context.disable(); });

it('exports active job, workflow, stream, scheduler and adapter spans without payload attributes', async () => {
  const errors: string[] = [];
  const flow = createFlow({ adapter: 'memory', telemetry: { enabled: true, provider: 'custom', tracer: provider.getTracer('test') }, onError: (error, info) => { errors.push(`${info.operation}:${error.message}`); throw new Error('observer failure'); } });
  const active: string[] = [];
  const checkActive = async () => { const before = trace.getActiveSpan()?.spanContext().spanId; await Promise.resolve(); expect(trace.getActiveSpan()?.spanContext().spanId).toBe(before); expect(before).toBeDefined(); active.push(before!); };
  try {
    const queue = flow.queue('jobs');
    queue.process(async job => { await checkActive(); if (job.name === 'fail') throw new Error('handler failure'); return true; });
    await queue.add('success', { secret: 'never-export' });
    await queue.add('fail', { secret: 'never-export' });
    await queue.drain();
    const workflow = flow.workflow('workflow').step('step', async () => { await checkActive(); return 4; }).build();
    const execution = await workflow.execute({ secret: 'never-export' });
    expect((await workflow.waitForCompletion(execution.id)).output).toBe(4);
    const stream = flow.stream('events');
    const received = vi.fn(async () => { await checkActive(); });
    const subscription = await stream.subscribe(received);
    await stream.publish({ secret: 'never-export' });
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1));
    await subscription.unsubscribe();
    await flow.scheduler().schedule('scheduled', { every: 1, limit: 1 }, checkActive);
    await vi.waitFor(async () => expect(await flow.scheduler().list()).toEqual([]));
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    for (const name of ['flowfn.job.execute', 'flowfn.workflow.step', 'flowfn.stream.process', 'flowfn.schedule.execute', 'flowfn.adapter.createJob']) expect(spans.some(span => span.name === name)).toBe(true);
    expect(spans.filter(span => span.name === 'flowfn.job.execute').map(span => span.status.code)).toContain(SpanStatusCode.ERROR);
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain('never-export');
    const step = spans.find(span => span.name === 'flowfn.workflow.step')!;
    expect(spans.some(span => span.name === 'flowfn.adapter.mutateWorkflowState' && span.parentSpanContext?.spanId === step.spanContext().spanId)).toBe(true);
    expect(errors).toContain('flowfn.job.execute:handler failure');
    expect(active).toHaveLength(5);
  } finally { await flow.close(); }
});

it('supports global enable/disable while explicit disabled flows remain disabled', async () => {
  const instrumentation = new FlowInstrumentation({ tracer: provider.getTracer('global') });
  const flow = createFlow({ adapter: 'memory' });
  const disabled = createFlow({ adapter: 'memory', telemetry: { enabled: false } });
  try {
    instrumentation.enable(); instrumentation.enable();
    await flow.queue('enabled').add('job', {});
    const count = exporter.getFinishedSpans().length;
    expect(count).toBeGreaterThan(0);
    await disabled.queue('disabled').add('job', {});
    expect(exporter.getFinishedSpans()).toHaveLength(count);
    instrumentation.disable();
    await flow.queue('enabled').add('job', {});
    expect(exporter.getFinishedSpans()).toHaveLength(count);
  } finally { instrumentation.disable(); await flow.close(); await disabled.close(); }
});

it('reports adapter errors without tracing and isolates rejected async observers', async () => {
  const adapter = new MemoryAdapter();
  const original = new Error('storage unavailable');
  adapter.createJob = async () => { throw original; };
  const onError = vi.fn(async () => { throw new Error('observer unavailable'); });
  const flow = createFlow({ adapter, onError });
  try {
    await expect(flow.queue('jobs').add('job', {})).rejects.toBe(original);
    expect(onError).toHaveBeenCalledWith(original, expect.objectContaining({ operation: 'flowfn.adapter.createJob' }));
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  } finally { await flow.close(); }
});

it('never repeats callbacks when a custom tracer fails after invocation', async () => {
  let calls = 0;
  const tracer = { startActiveSpan: (_name: string, _options: unknown, callback: Function) => { callback({ end() {}, recordException() {}, setStatus() {} }); throw new Error('tracer failed'); } } as unknown as Tracer;
  const observer = new OperationObserver({ enabled: true, provider: 'custom', tracer });
  await expect(observer.run('operation', {}, () => { calls++; return 1; })).resolves.toBe(1);
  expect(calls).toBe(1);
});
