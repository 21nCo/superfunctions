import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import {
  BrowserAutomationAdapter,
  leaveBrowserMeeting,
} from 'recfn-browser-core';
import { createMeetBrowserSession } from './browser.js';
import { createMeetAudioStream } from './audio-capture.js';
import {
  createMeetParticipantTracker,
  type MeetParticipantTracker,
} from './participants.js';
import { createMeetChatTracker, type MeetChatTracker } from './chat.js';

export { createMeetBrowserSession } from './browser.js';
export type { MeetBrowserConfig, MeetBrowserSession } from './browser.js';
export { createMeetAudioStream } from './audio-capture.js';
export { createMeetParticipantTracker } from './participants.js';
export type { MeetParticipantTracker } from './participants.js';
export { createMeetChatTracker } from './chat.js';
export type { MeetChatTracker } from './chat.js';

export interface MeetAdapterConfig {
  browser?: Browser;
  testPage?: Page;
  userDataDir?: string;
  joinTimeout?: number;
  headless?: boolean;
  executablePath?: string;
  browserArgs?: string[];
}

async function writeMeetJoinDebugArtifacts(
  page: Page,
  error: unknown,
): Promise<Error> {
  const dir = process.env.RECFN_MEET_DEBUG_DIR ?? '/tmp/recfn-meet-debug';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(dir, { recursive: true }).catch(() => {});

  const screenshotPath = join(dir, `meet-join-${stamp}.png`);
  const htmlPath = join(dir, `meet-join-${stamp}.html`);
  const statePath = join(dir, `meet-join-${stamp}.txt`);

  const [title, url, bodyText, html] = await Promise.all([
    page.title().catch(() => ''),
    Promise.resolve(page.url()).catch(() => ''),
    page.locator('body').innerText({ timeout: 1_000 }).catch(() => ''),
    page.content().catch(() => ''),
  ]);

  await Promise.all([
    page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {}),
    writeFile(htmlPath, html).catch(() => {}),
    writeFile(
      statePath,
      [
        `url=${url}`,
        `title=${title}`,
        `error=${error instanceof Error ? error.message : String(error)}`,
        '',
        bodyText.slice(0, 2_000),
      ].join('\n'),
    ).catch(() => {}),
  ]);

  return new Error(
    [
      error instanceof Error ? error.message : 'Join timeout exceeded',
      `Meet debug artifacts: ${screenshotPath}, ${htmlPath}, ${statePath}`,
      bodyText ? `Visible text: ${bodyText.slice(0, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * Google Meet platform adapter using headless browser (Playwright).
 *
 * Prerequisites:
 * - Chrome/Chromium: `npx playwright install chromium`
 * - Google account for bot (optional; some meetings allow "Ask to join" without auth)
 */
export class MeetAdapter extends BrowserAutomationAdapter<
  MeetParticipantTracker,
  MeetChatTracker
> {
  constructor(config: MeetAdapterConfig = {}) {
    super(config, {
      platform: 'meet',
      metadataId: 'meet',
      defaultTitle: 'Google Meet',
      createSession: createMeetBrowserSession,
      joinMeeting: async (page, joinTimeout, botConfig) => {
        try {
          const displayName = botConfig.displayName ?? 'Recording Bot';
          const clickTarget = await page.evaluate((name) => {
            const nameInput = Array.from(
              document.querySelectorAll('input, textarea'),
            ).find((input) => {
              const el = input as HTMLInputElement | HTMLTextAreaElement;
              const label = [
                el.getAttribute('aria-label'),
                el.getAttribute('placeholder'),
                el.closest('label')?.textContent,
                el.parentElement?.textContent,
              ]
                .filter(Boolean)
                .join(' ');
              return /name/i.test(label);
            }) as HTMLInputElement | HTMLTextAreaElement | undefined;

            if (nameInput && !nameInput.value.trim()) {
              nameInput.focus();
              const valueSetter = Object.getOwnPropertyDescriptor(
                Object.getPrototypeOf(nameInput),
                'value',
              )?.set;
              valueSetter?.call(nameInput, name);
              nameInput.dispatchEvent(new Event('input', { bubbles: true }));
              nameInput.dispatchEvent(new Event('change', { bubbles: true }));
            }

            const findJoinButton = () => {
              const buttons = Array.from(
                document.querySelectorAll('button, [role="button"]'),
              ) as HTMLElement[];
              const isEnabled = (button: HTMLElement) =>
                !button.hasAttribute('disabled') &&
                button.getAttribute('aria-disabled') !== 'true';
              const labelFor = (button: HTMLElement) =>
                `${button.innerText ?? ''} ${button.getAttribute('aria-label') ?? ''}`.trim();
              const joinButton =
                buttons.find(
                  (button) =>
                    isEnabled(button) &&
                    /^(join now|ask to join)$/i.test(labelFor(button)),
                ) ??
                buttons.find((button) => {
                  const label = labelFor(button);
                  return (
                    isEnabled(button) &&
                    /join now|ask to join/i.test(label) &&
                    !/other ways/i.test(label)
                  );
                });
              return joinButton;
            };

            const joinButton = findJoinButton();
            if (!joinButton) {
              const bodyText = document.body?.innerText ?? '';
              if (/you'?ll be able to join|you will be able to join|asking to join|waiting/i.test(bodyText)) {
                return { ok: true as const, waiting: true as const };
              }
              return { ok: false as const, reason: 'Join button not found.' };
            }

            const rect = joinButton.getBoundingClientRect();
            return {
              ok: true as const,
              waiting: false as const,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              label: `${joinButton.innerText ?? ''} ${joinButton.getAttribute('aria-label') ?? ''}`.trim(),
            };
          }, displayName);

          if (!clickTarget.ok) {
            throw new Error(clickTarget.reason);
          }

          if (!clickTarget.waiting) {
            await page.evaluate(() => {
              const buttons = Array.from(
                document.querySelectorAll('button, [role="button"]'),
              ) as HTMLElement[];
              const joinButton = buttons.find((button) => {
                const label = `${button.innerText ?? ''} ${button.getAttribute('aria-label') ?? ''}`.trim();
                return /^(join now|ask to join)$/i.test(label);
              });
              joinButton?.scrollIntoView({ block: 'center', inline: 'center' });
              joinButton?.focus();
            });
            await page.mouse.move(clickTarget.x, clickTarget.y);
            await page.mouse.down();
            await page.waitForTimeout(100);
            await page.mouse.up();
            await page.waitForTimeout(1_000);

            const clicked = await page.evaluate(() => {
              const bodyText = document.body?.innerText ?? '';
              return !/ask to join/i.test(bodyText) || /asking to join|you'?ll be able to join|you will be able to join|waiting for.*host/i.test(bodyText);
            });
            if (!clicked) {
              throw new Error(`Meet join button did not activate after click.`);
            }
          }

          await page.waitForFunction(
            () => {
              const bodyText = document.body?.innerText ?? '';
              if (/you can'?t join|not allowed to join|meeting is full/i.test(bodyText)) {
                throw new Error(bodyText.slice(0, 500));
              }

              return Array.from(
                document.querySelectorAll('button, [role="button"]'),
              ).some((control) => {
                const el = control as HTMLElement;
                const label = `${el.innerText ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
                return /leave call|leave/i.test(label);
              });
            },
            undefined,
            { timeout: joinTimeout },
          );
        } catch (error) {
          throw await writeMeetJoinDebugArtifacts(page, error);
        }
      },
      leaveMeeting: async (page) => {
        await leaveBrowserMeeting(page, async (leavePage) => {
          await leavePage.evaluate(() => {
            const leaveButton = document.querySelector(
              '[aria-label*="Leave"], [aria-label*="Leave call"]',
            ) as HTMLButtonElement | null;
            if (leaveButton) {
              leaveButton.click();
            }
          });
        });
      },
      createParticipantTracker: (page, botId) =>
        createMeetParticipantTracker(page, botId),
      createChatTracker: (page) => createMeetChatTracker(page),
      createAudioStream: (page) => createMeetAudioStream(page),
    });
  }
}
