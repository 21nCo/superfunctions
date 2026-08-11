import type { ChatMessage } from 'recfn';
import type { Page } from 'playwright';
import {
  createBrowserChatTracker,
  type BrowserChatEntry,
} from 'recfn-browser-core';

export interface MeetChatTracker {
  getMessages(): ChatMessage[];
  onMessage(cb: (msg: ChatMessage) => void): void;
  send(text: string): Promise<void>;
  startObserving(): Promise<void>;
  stopObserving(): void;
}

async function enableMeetCaptions(page: Page): Promise<void> {
  const clickedCaptionControl = await page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll('button, [role="button"]'),
    ) as HTMLElement[];

    const labelFor = (control: HTMLElement) =>
      [
        control.innerText,
        control.getAttribute('aria-label'),
        control.getAttribute('data-tooltip'),
        control.getAttribute('title'),
      ]
        .filter(Boolean)
        .join(' ');

    const turnOnControl = controls.find((control) => {
      const label = labelFor(control);
      return (
        /turn on captions|show captions|captions off|closed captions/i.test(label) &&
        !/turn off captions|hide captions|captions on/i.test(label)
      );
    });

    if (turnOnControl) {
      turnOnControl.click();
      return true;
    }

    return false;
  });

  if (!clickedCaptionControl) {
    const canUseShortcut = await page.evaluate(() => {
      const active = document.activeElement;
      if (!active || active === document.body) {
        return true;
      }
      return !(
        active instanceof HTMLElement &&
        (active.isContentEditable ||
          active.matches('input, textarea, select, [role="textbox"]'))
      );
    });
    if (canUseShortcut) {
      await page.keyboard.press('c').catch(() => {});
    }
  }
}

function evaluateMeetMessages(): BrowserChatEntry[] {
  const entries: BrowserChatEntry[] = [];
  const now = new Date().toISOString();
  const seen = new Set<string>();
  const w = window as typeof window & {
    __REC_FN_MEET_CAPTION_LAST_BY_SPEAKER__?: Record<string, string>;
  };
  const lastCaptionBySpeaker =
    w.__REC_FN_MEET_CAPTION_LAST_BY_SPEAKER__ ??
    (w.__REC_FN_MEET_CAPTION_LAST_BY_SPEAKER__ = {});

  const push = (participantId: string, text: string, timestamp = now) => {
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    const normalizedParticipantId =
      participantId.replace(/\s+/g, ' ').trim() || 'captions';
    if (!normalizedText) {
      return;
    }
    const key = `${normalizedParticipantId}\n${normalizedText}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({
      participantId: normalizedParticipantId,
      text: normalizedText,
      timestamp,
    });
  };

  const chatItems = document.querySelectorAll(
    '[data-message-id], .zWGUib [data-sender], .chat-message',
  );
  chatItems.forEach((el: Element, i: number) => {
    const participantId =
      (el as HTMLElement).getAttribute?.('data-sender') ?? `sender_${i}`;
    const text = (el as HTMLElement).textContent?.trim() ?? '';
    push(participantId, text);
  });

  const captionCandidates = Array.from(
    document.querySelectorAll(
      [
        '[aria-live="polite"]',
        '[aria-live="assertive"]',
        '.iTTPOb',
        '.TBMuR',
        '.a4cQT',
        '.CNusmb',
        '.nMcdL',
      ].join(','),
    ),
  ) as HTMLElement[];

  const blockedText =
    /^(sign in|more options|visual effects|start|join now|ask to join|other ways to join|got it)$/i;
  const captionSettingsText =
    /(?:arrow_downward|jump to bottom|format_size|font size|font color|open caption settings|caption settings|^language$|^english$)/i;

  for (const candidate of captionCandidates) {
    if (candidate.closest('button, input, textarea, [role="button"]')) {
      continue;
    }

    const rect = candidate.getBoundingClientRect();
    const style = window.getComputedStyle(candidate);
    if (
      style.visibility === 'hidden' ||
      style.display === 'none' ||
      rect.width < 20 ||
      rect.height < 8 ||
      rect.top < window.innerHeight * 0.35
    ) {
      continue;
    }

    const rawText = candidate.innerText?.trim() || candidate.textContent?.trim() || '';
    if (!rawText || rawText.length > 500) {
      continue;
    }
    if (captionSettingsText.test(rawText)) {
      continue;
    }

    const lines = rawText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !blockedText.test(line))
      .filter((line) => !captionSettingsText.test(line));

    if (lines.length === 0) {
      continue;
    }

    let participantId = 'captions';
    let text = lines.join(' ');
    if (lines.length > 1 && lines[0].length <= 80) {
      participantId = lines[0];
      text = lines.slice(1).join(' ');
    }

    const previousCaption = lastCaptionBySpeaker[participantId];
    if (previousCaption) {
      if (
        text === previousCaption ||
        previousCaption.startsWith(text)
      ) {
        continue;
      }
      if (text.startsWith(previousCaption)) {
        text = text
          .slice(previousCaption.length)
          .replace(/^[\s,.;:!?-]+/, '')
          .trim();
      }
    }
    lastCaptionBySpeaker[participantId] = lines.length > 1
      ? lines.slice(1).join(' ')
      : lines.join(' ');

    push(participantId, text);
  }

  return entries;
}

/**
 * DOM-based chat capture and send for Google Meet.
 * Observes the chat panel and live captions for new messages.
 * Sends messages by typing into the chat input.
 */
export function createMeetChatTracker(
  page: Page,
): MeetChatTracker {
  const tracker = createBrowserChatTracker({
    page,
    evaluateMessages: evaluateMeetMessages,
    sendMessage: async (currentPage, text) => {
      const input = await currentPage.$(
        '[data-idom-class*="chat"], [aria-label*="chat"] input, [placeholder*="message"]',
      );
      if (input) {
        await input.fill(text);
        await currentPage.keyboard.press('Enter');
      }
    },
  });

  return {
    getMessages: () => tracker.getMessages(),
    onMessage: (cb) => tracker.onMessage(cb),
    send: (text) => tracker.send(text),
    startObserving: async () => {
      await enableMeetCaptions(page).catch(() => {});
      await tracker.startObserving();
    },
    stopObserving: () => tracker.stopObserving(),
  };
}
