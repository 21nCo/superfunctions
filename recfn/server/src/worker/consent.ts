import type { PlatformAdapter } from '@recfn/core';
import type { Logger } from '../integrations/logfn.js';

/**
 * Sends the consent message via the platform adapter's sendChatMessage.
 * Bot MUST NOT transition to recording until this completes (or fails non-fatally).
 * On failure: logs warning and returns (non-fatal — bot proceeds to recording).
 */
export async function sendConsentMessage(
  adapter: PlatformAdapter,
  message: string,
  botId: string,
  logger: Logger,
): Promise<void> {
  try {
    await adapter.sendChatMessage(message);
    logger.info('bot.consent_sent', { botId, message });
  } catch {
    logger.warn('bot.consent_failed', { botId });
    // Non-fatal: proceed to recording per TV-BOT-010
  }
}
