import type { Bot } from 'recfn';
import type { LifecycleDeps } from './lifecycle.js';
import { transitionBot } from './lifecycle.js';

export interface AutoLeaveTimer {
  start(bot: Bot): void;
  cancel(botId: string): void;
  cancelAll(): void;
  onParticipantLeave(bot: Bot, remainingNonBotCount: number): void;
  onParticipantJoin(botId: string): void;
}

export function createAutoLeaveTimer(deps: LifecycleDeps): AutoLeaveTimer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    start(bot: Bot) {
      if (!bot.config.autoLeaveOnEmpty) return;

      const existing = timers.get(bot.id);
      if (existing) clearTimeout(existing);

      const timeout = bot.config.autoLeaveEmptyTimeout ?? 30_000;
      const timer = setTimeout(async () => {
        timers.delete(bot.id);
        try {
          await transitionBot(deps, bot.id, bot.namespace, 'leaving');
        } catch {
          // Bot may have already transitioned
        }
      }, timeout);

      timers.set(bot.id, timer);
    },

    cancel(botId: string) {
      const timer = timers.get(botId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(botId);
      }
    },

    cancelAll() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },

    onParticipantLeave(bot: Bot, remainingNonBotCount: number) {
      if (!bot.config.autoLeaveOnEmpty) return;
      if (remainingNonBotCount <= 0) {
        this.start(bot);
      }
    },

    onParticipantJoin(botId: string) {
      this.cancel(botId);
    },
  };
}
