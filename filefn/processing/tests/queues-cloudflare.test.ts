import { describe, it, expect, vi } from 'vitest';
import {
  createCloudflareFlowFnProvider,
  createCloudflareQueueProducer,
  PROCESSING_QUEUE_NAME,
  type CloudflareQueueBinding,
} from '../src/queues/cloudflare.js';
import * as root from '../src/index.js';

function createBinding(send: CloudflareQueueBinding['send'] = async () => undefined) {
  return { send: vi.fn(send) };
}

const job = {
  fileId: 'file_1',
  versionId: 'ver_1',
  idempotencyKey: 'processing:file_1:ver_1:thumbnail',
};

describe('Cloudflare Queues producer', () => {
  it('sends the job as a JSON message carrying the jobId it returns', async () => {
    const binding = createBinding();
    const producer = createCloudflareQueueProducer({ queue: binding, generateJobId: () => 'job_fixed' });

    const result = await producer.add(job);

    expect(producer.name).toBe(PROCESSING_QUEUE_NAME);
    expect(result).toEqual({ jobId: 'job_fixed' });
    expect(binding.send).toHaveBeenCalledTimes(1);
    expect(binding.send).toHaveBeenCalledWith({ ...job, jobId: 'job_fixed' }, { contentType: 'json' });
  });

  it('generates a distinct UUID jobId per message by default', async () => {
    const binding = createBinding();
    const producer = createCloudflareQueueProducer({ queue: binding });

    const first = await producer.add(job);
    const second = await producer.add(job);

    expect(first.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.jobId).not.toBe(first.jobId);
    expect(binding.send.mock.calls[1][0]).toMatchObject({ jobId: second.jobId });
  });

  it('forwards a configured delivery delay', async () => {
    const binding = createBinding();
    const producer = createCloudflareQueueProducer({ queue: binding, delaySeconds: 30, generateJobId: () => 'j' });

    await producer.add(job);

    expect(binding.send).toHaveBeenCalledWith(expect.anything(), { contentType: 'json', delaySeconds: 30 });
  });

  it('rejects add when the binding rejects the send', async () => {
    const binding = createBinding(async () => {
      throw new Error('queue unavailable');
    });
    const producer = createCloudflareQueueProducer({ queue: binding });

    await expect(producer.add(job)).rejects.toThrow('queue unavailable');
  });

  it('refuses non-object jobs without sending', async () => {
    const binding = createBinding();
    const producer = createCloudflareQueueProducer({ queue: binding });

    await expect(producer.add('file_1')).rejects.toThrow('FILEFN_QUEUE_JOB_INVALID');
    await expect(producer.add([job])).rejects.toThrow('FILEFN_QUEUE_JOB_INVALID');
    await expect(producer.add(null)).rejects.toThrow('FILEFN_QUEUE_JOB_INVALID');
    expect(binding.send).not.toHaveBeenCalled();
  });

  it('refuses an invalid binding or settings at creation', () => {
    expect(() => createCloudflareQueueProducer({ queue: undefined as never })).toThrow('FILEFN_QUEUE_BINDING_INVALID');
    expect(() => createCloudflareQueueProducer({ queue: createBinding(), delaySeconds: -1 })).toThrow(
      'FILEFN_QUEUE_DELAY_INVALID',
    );
    expect(() => createCloudflareQueueProducer({ queue: createBinding(), delaySeconds: 1.5 })).toThrow(
      'FILEFN_QUEUE_DELAY_INVALID',
    );
  });
});

describe('Cloudflare FlowFn provider', () => {
  it('returns the producer bound to a queue name and nothing for other names', async () => {
    const binding = createBinding();
    const provider = createCloudflareFlowFnProvider(
      { [PROCESSING_QUEUE_NAME]: binding, 'other.queue': undefined },
      { generateJobId: () => 'job_2' },
    );

    const queue = provider.getQueue(PROCESSING_QUEUE_NAME);
    expect(queue?.name).toBe(PROCESSING_QUEUE_NAME);
    expect(provider.getQueue(PROCESSING_QUEUE_NAME)).toBe(queue);
    expect(provider.getQueue('other.queue')).toBeUndefined();
    expect(provider.getQueue('missing')).toBeUndefined();

    await expect(queue!.add(job)).resolves.toEqual({ jobId: 'job_2' });
    expect(binding.send).toHaveBeenCalledWith({ ...job, jobId: 'job_2' }, { contentType: 'json' });
  });

  it('is also exported from the package root', () => {
    expect(root.createCloudflareFlowFnProvider).toBe(createCloudflareFlowFnProvider);
    expect(root.createCloudflareQueueProducer).toBe(createCloudflareQueueProducer);
  });
});
