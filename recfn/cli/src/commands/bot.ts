import { program } from 'commander';
import type { RecFn } from '@recfn/client';
import type { OutputFormat } from '../output.js';
import { formatJson, formatBotList, formatBot } from '../output.js';

export function registerBotCommands(recfn: RecFn, format: () => OutputFormat) {
  const bot = program.command('bot').description('Bot management');

  bot
    .command('create <meetingUrl>')
    .description('Create a bot and join the meeting')
    .option('-p, --platform <platform>', 'Platform: zoom, meet, teams')
    .option('-n, --name <name>', 'Bot display name')
    .action(async (meetingUrl: string, opts: { platform?: string; name?: string }) => {
      const result = await recfn.bots.create({
        meetingUrl,
        platform: opts.platform as 'zoom' | 'meet' | 'teams' | undefined,
        config: opts.name ? { displayName: opts.name } : undefined,
      });
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(`Bot created: ${result.data.id} (status: ${result.data.status})`);
      }
    });

  bot
    .command('status <botId>')
    .description('Get bot status and details')
    .action(async (botId: string) => {
      const result = await recfn.bots.get(botId);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(formatBot(result.data));
      }
    });

  bot
    .command('leave <botId>')
    .description('Leave the meeting')
    .action(async (botId: string) => {
      const result = await recfn.bots.leave(botId);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(`Bot ${result.data.botId} is leaving.`);
      }
    });

  bot
    .command('list')
    .description('List bots')
    .option('-s, --status <status>', 'Filter by status')
    .option('-l, --limit <n>', 'Limit', '20')
    .action(async (opts: { status?: string; limit?: string }) => {
      const result = await recfn.bots.list({
        status: opts.status as 'creating' | 'joining' | 'joined' | 'recording' | 'leaving' | 'left' | 'done' | 'error' | undefined,
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
      });
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
      if (format() === 'json') {
        console.log(formatJson(result.data));
      } else {
        console.log(formatBotList(result.data));
      }
    });
}
