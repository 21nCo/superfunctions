import { Command } from 'commander';
import { apiCall } from '../utils/api.js';

export const statusCommand = new Command('status')
  .description('Show status of a run or list recent runs')
  .arguments('[runId]')
  .option('--format <format>', 'Output format (text|json)', 'text')
  .action(async (runId, options) => {
    try {
      if (runId) {
        const res = await apiCall(`/api/v1/runs/${runId}`);
        if (!res.ok) {
          console.error(`Error: ${res.data?.error?.message || 'Failed to fetch run'}`);
          process.exit(1);
        }
        
        const run = res.data.data;
        if (options.format === 'json') {
          console.log(JSON.stringify(run, null, 2));
        } else {
          console.log(`Run ID: ${run.runId}`);
          console.log(`Status: ${run.status}`);
          console.log(`Created: ${run.createdAt}`);
          console.log(`Trigger: ${run.trigger.type}`);
          console.log('Jobs:');
          run.jobs.forEach((job: any) => {
            console.log(`  - ${job.jobKey}: ${job.status}`);
            job.steps.forEach((step: any) => {
              console.log(`    - ${step.stepKey}: ${step.status}`);
            });
          });
        }
      } else {
        const res = await apiCall('/api/v1/runs?limit=20');
        if (!res.ok) {
          console.error(`Error: ${res.data?.error?.message || 'Failed to list runs'}`);
          process.exit(1);
        }

        const runs = res.data.data.runs;
        if (options.format === 'json') {
          console.log(JSON.stringify(runs, null, 2));
        } else {
          console.log('Recent runs:');
          console.log('ID\t\t\t\t\t\tStatus\t\tCreated'); // Tabs might be messy, but basic enough
          runs.forEach((run: any) => {
            console.log(`${run.runId}\t${run.status}\t${run.createdAt}`);
          });
        }
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });
