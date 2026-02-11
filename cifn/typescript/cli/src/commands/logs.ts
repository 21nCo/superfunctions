import { Command } from 'commander';
import { apiCall } from '../utils/api.js';

export const logsCommand = new Command('logs')
  .description('View logs for a run or job')
  .arguments('<runId> [jobKey]')
  .action(async (runId, jobKey) => {
    try {
      if (jobKey) {
        await printJobLogs(runId, jobKey);
      } else {
        // Fetch run to get job keys
        const res = await apiCall(`/api/v1/runs/${runId}`);
        if (!res.ok) {
          console.error(`Error: ${res.data?.error?.message || 'Failed to fetch run'}`);
          process.exit(1);
        }
        const run = res.data.data;
        for (const job of run.jobs) {
          console.log(`--- Job: ${job.jobKey} ---`);
          await printJobLogs(runId, job.jobKey);
          console.log('\n');
        }
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

function redactLine(line: string): string {
  let redacted = line;
  
  redacted = redacted.replace(/ghp_[a-zA-Z0-9]{36}/g, '***');
  redacted = redacted.replace(/ghs_[a-zA-Z0-9]{36}/g, '***');
  redacted = redacted.replace(/github_pat_[a-zA-Z0-9_]{82}/g, '***');
  redacted = redacted.replace(/(password|token|secret|key)=[^\s&]+/gi, '$1=***');
  redacted = redacted.replace(/(Authorization|Bearer)\s+[^\s]+/gi, (match, prefix) => `${prefix} ***`);
  
  return redacted;
}

async function printJobLogs(runId: string, jobKey: string) {
  const res = await apiCall(`/api/v1/runs/${runId}/jobs/${jobKey}/logs`);
  if (!res.ok) {
    console.error(`Failed to fetch logs for job ${jobKey}: ${res.data?.error?.message}`);
    return;
  }

  const lines = res.data.data.lines;
  if (lines && Array.isArray(lines)) {
    lines.forEach((l: any) => {
      const redactedLine = redactLine(l.line);
      console.log(`[${l.timestamp}] ${redactedLine}`);
    });
  } else {
    console.log('(No logs)');
  }
}
