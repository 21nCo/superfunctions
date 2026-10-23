import { Command } from 'commander';
import { loadConfig } from '../utils/config.js';
import { apiCall } from '../utils/api.js';

export const runCommand = new Command('run')
  .description('Create a new run from a local pipeline config')
  .option('-c, --config <path>', 'Path to pipeline config file')
  .option('-t, --trigger <type>', 'Trigger type', 'workflow_dispatch')
  .option('--local', 'Execute pipeline locally (no control plane required)')
  .action(async (options) => {
    if (options.local) {
      await runLocalMode(options);
      return;
    }
    try {
      const { config, path } = loadConfig(options.config);
      
      const payload = {
        pipelineSpec: config,
        trigger: {
          type: options.trigger,
        },
        // We could infer repo/ref from git here if we wanted to populate pipelineRef,
        // but for now we rely on the API defaults.
      };

      const res = await apiCall('/api/v1/runs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      if (res.ok && res.data.ok) {
        console.log(`Run created: ${res.data.data.runId}`);
        process.exit(0);
      } else {
        const error = res.data?.error;
        console.error(`Failed to create run: ${error?.code} - ${error?.message}`);
        if (error?.details) {
          console.error(JSON.stringify(error.details, null, 2));
        }
        process.exit(1);
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

async function runLocalMode(options: { config?: string; trigger: string }) {
  try {
    const { config } = loadConfig(options.config);
    
    const { MemoryStore } = await import('cifn');
    const { MemoryQueueClient, DEFAULT_QUEUE_NAME } = await import('cifn');
    const { MemoryLogFnClient } = await import('cifn-runner/dist/reporting/logfn-client.js');
    const { Runner } = await import('cifn-runner');
    const { parsePipeline, validatePipeline, getReadyJobs } = await import('cifn');
    
    const parseResult = parsePipeline(config);
    if (!parseResult.ok) {
      console.error(`Pipeline parse failed: ${parseResult.error}`);
      process.exit(1);
    }
    
    const validateResult = validatePipeline(parseResult.spec);
    if (!validateResult.valid) {
      console.error(`Pipeline validation failed: ${validateResult.errors.join(', ')}`);
      process.exit(1);
    }
    
    const store = new MemoryStore();
    const queue = new MemoryQueueClient();
    const logClient = new MemoryLogFnClient();
    
    const run = store.createRun({
      pipelineSpec: parseResult.spec,
      trigger: { type: options.trigger as any, payload: { github: { ref: 'refs/heads/local' } } },
    });
    
    const runId = run.id;
    console.log(`Local run created: ${runId}`);
    console.log(`Pipeline: ${parseResult.spec.name}`);
    console.log('');
    
    const completedJobs = new Set<string>();
    const enqueuedJobs = new Set<string>();
    
    const readyJobs = getReadyJobs(parseResult.spec, completedJobs, enqueuedJobs);
    for (const jobKey of readyJobs) {
      const jobSpec = parseResult.spec.jobs[jobKey];
      if (jobSpec) {
        await queue.enqueue(DEFAULT_QUEUE_NAME, { runId, jobKey, jobSpec });
        enqueuedJobs.add(jobKey);
      }
    }
    
    const runner = new Runner({
      store,
      queue,
      logClient,
      pipelineSpecs: new Map([[runId, parseResult.spec]]),
      queueName: DEFAULT_QUEUE_NAME,
      cleanWorkspace: true,
      labels: ['default'],
    });
    
    runner.registerPipelineSpec(runId, parseResult.spec);
    
    let jobsProcessed = 0;
    while (await runner.processNextJob()) {
      jobsProcessed++;
    }
    
    const finalRun = store.getRun(runId);
    if (!finalRun) {
      console.error('Run not found after execution');
      process.exit(1);
    }
    
    console.log('');
    console.log('Run completed:');
    console.log(`  Status: ${finalRun.status}`);
    console.log(`  Jobs processed: ${jobsProcessed}`);
    console.log('');
    console.log('Jobs:');
    for (const job of finalRun.jobs) {
      console.log(`  ${job.jobKey}: ${job.status}`);
      for (const step of job.steps) {
        console.log(`    - ${step.stepKey}: ${step.status}`);
      }
    }
    
    console.log('');
    console.log('Logs:');
    const allLogs = logClient.getAllLines(runId);
    for (const entry of allLogs) {
      console.log(`[${entry.jobKey}/${entry.stepKey}] ${entry.line}`);
    }
    
    process.exit(finalRun.status === 'success' ? 0 : 1);
  } catch (error: any) {
    console.error(`Local run error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}
