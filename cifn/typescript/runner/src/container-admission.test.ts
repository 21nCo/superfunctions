import { expect, it, vi } from 'vitest';
import { Runner } from './runner.js';
import { MemoryLogFnClient } from './reporting/logfn-client.js';
import { MemoryStore, MemoryQueueClient, DEFAULT_QUEUE_NAME } from '@cifn/control-plane';
import { DockerExecutor } from './docker-executor.js';
async function execute(image: string | undefined, dockerExecutor?: DockerExecutor, dockerForDefault = false) {
  const store = new MemoryStore(), queue = new MemoryQueueClient(), logClient = new MemoryLogFnClient();
  const host = vi.fn(async () => ({exitCode:0,stdout:'host',stderr:'',lines:['host']}));
  const spec = {on:{workflow_dispatch:{}},jobs:{build:{'runs-on':'default',...(image !== undefined ? {image} : {}),steps:[{run:'printf should-use-declared-executor'}]}}};
  const run = store.createRun({pipelineSpec:spec,trigger:{type:'workflow_dispatch'}});
  const runner = new Runner({store,queue,logClient,runCommand:host,dockerExecutor,dockerForDefault});runner.registerPipelineSpec(run.id,spec);
  await queue.enqueue(DEFAULT_QUEUE_NAME,{runId:run.id,jobKey:'build',jobSpec:spec.jobs.build});await runner.processAllJobs();
  return {run:store.getRun(run.id)!,host,logClient};
}
it('fails an image-required step without invoking any host execution fallback', async () => {
  for (const image of ['owned-fixture:unavailable', '']) { const {run,host}=await execute(image);expect(host).not.toHaveBeenCalled();expect(run.status).toBe('failure');expect(run.jobs[0].steps[0].status).toBe('failure'); }
  const required = await execute(undefined, undefined, true); expect(required.host).not.toHaveBeenCalled(); expect(required.run.status).toBe('failure');
});
it('preserves explicit container selection and image-free host execution', async () => {
  const docker=vi.fn(()=>({status:0,stdout:'container',stderr:''}));const inside=await execute('owned-fixture:configured',new DockerExecutor({run:docker}));expect(docker).toHaveBeenCalledOnce();expect(inside.host).not.toHaveBeenCalled();expect(inside.run.status).toBe('success');
  const outside=await execute(undefined);expect(outside.host).toHaveBeenCalledOnce();expect(outside.run.status).toBe('success');
});
