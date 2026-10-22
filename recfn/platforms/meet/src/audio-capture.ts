import { createError, type AudioChunk } from '@recfn/core';
import type { Page } from 'playwright';
import {
  MEET_AUDIO_CAPTURE_POLL_INTERVAL_MS,
  MEET_AUDIO_CAPTURE_TIMESLICE_MS,
} from './browser.js';

/**
 * Captures Meet audio through browser display-media capture with MediaRecorder.
 * Tests can inject canned chunks via window.__REC_FN_MEET_TEST_AUDIO_CHUNKS__.
 */
interface MeetCaptureStartResult {
  ok: boolean;
  sessionId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  sampleRate?: number;
  channels?: number;
  encoding?: AudioChunk['encoding'];
}

interface MeetCapturePollResult {
  chunks: number[][];
  done: boolean;
  error?: string | null;
  sampleRate?: number;
  channels?: number;
  encoding?: AudioChunk['encoding'];
}

function createMeetCaptureUnavailableError(
  message: string,
  details?: Record<string, unknown>,
) {
  return createError(
    'PLATFORM_CAPTURE_UNAVAILABLE' as unknown as Parameters<typeof createError>[0],
    message,
    {
    platform: 'meet',
    ...(details ?? {}),
    },
  );
}

export function createMeetAudioStream(
  page: Page,
  options?: { sampleRate?: number },
): ReadableStream<AudioChunk> {
  let activeSessionId: string | undefined;
  let activePollTimeout: ReturnType<typeof setTimeout> | undefined;

  return new ReadableStream<AudioChunk>({
    async start(controller) {
      let closed = false;
      let sawData = false;

      const clearPendingPoll = () => {
        if (activePollTimeout) {
          clearTimeout(activePollTimeout);
          activePollTimeout = undefined;
        }
      };

      const stopCapture = () => {
        clearPendingPoll();
        if (!activeSessionId) {
          return;
        }

        void page
          .evaluate((sessionId) => {
            const w = window as typeof window & {
              __REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__?: Record<
                string,
                {
                  recorder?: MediaRecorder;
                  stream?: MediaStream;
                  audioStream?: MediaStream;
                }
              >;
            };
            const sessions = w.__REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__;
            const activeSession = sessions?.[sessionId];
            if (!activeSession) {
              return;
            }

            if (
              activeSession.recorder &&
              activeSession.recorder.state !== 'inactive'
            ) {
              activeSession.recorder.stop();
            }
            activeSession.audioStream?.getTracks().forEach((track) => track.stop());
            activeSession.stream?.getTracks().forEach((track) => track.stop());
            if (sessions) {
              delete sessions[sessionId];
            }
          }, activeSessionId)
          .catch(() => {});
      };

      try {
        const startResult = await page.evaluate(
          async ({
            sampleRate,
            timesliceMs,
          }: {
            sampleRate?: number;
            timesliceMs: number;
          }): Promise<MeetCaptureStartResult> => {
            const w = window as typeof window & {
              webkitAudioContext?: typeof AudioContext;
              __REC_FN_MEET_TEST_AUDIO_CHUNKS__?: number[][];
              __REC_FN_MEET_TEST_SAMPLE_RATE__?: number;
              __REC_FN_MEET_TEST_CHANNELS__?: number;
              __REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__?: Record<
                string,
                {
                  queue: number[][];
                  done: boolean;
                  error: string | null;
                  sampleRate: number;
                  channels: number;
                  encoding?: AudioChunk['encoding'];
                  recorder?: MediaRecorder;
                  stream?: MediaStream;
                  audioStream?: MediaStream;
                }
              >;
            };

            const sessions =
              w.__REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__ ??
              (w.__REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__ = {});
            const sessionId = `meet_capture_${Date.now()}_${Math.random()
              .toString(36)
              .slice(2, 8)}`;

            if (Array.isArray(w.__REC_FN_MEET_TEST_AUDIO_CHUNKS__)) {
              sessions[sessionId] = {
                queue: w.__REC_FN_MEET_TEST_AUDIO_CHUNKS__.map((chunk) => [...chunk]),
                done: true,
                error: null,
                sampleRate: w.__REC_FN_MEET_TEST_SAMPLE_RATE__ ?? sampleRate ?? 48_000,
                channels: w.__REC_FN_MEET_TEST_CHANNELS__ ?? 1,
              };
              return {
                ok: true,
                sessionId,
                sampleRate: sessions[sessionId].sampleRate,
                channels: sessions[sessionId].channels,
              };
            }

            const missingCapabilities: string[] = [];
            if (!navigator.mediaDevices?.getDisplayMedia) {
              missingCapabilities.push('getDisplayMedia');
            }
            const AudioContextClass = w.AudioContext ?? w.webkitAudioContext;
            if (!AudioContextClass) {
              missingCapabilities.push('AudioContext');
            }
            if (typeof MediaRecorder === 'undefined') {
              missingCapabilities.push('MediaRecorder');
            }
            if (missingCapabilities.length > 0) {
              return {
                ok: false,
                reason:
                  'Meet audio capture requires display-media capture support in this browser runtime.',
                details: { missingCapabilities },
              };
            }

            try {
              const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
              });
              const audioTracks = stream.getAudioTracks();
              if (audioTracks.length === 0) {
                stream.getTracks().forEach((track) => track.stop());
                return {
                  ok: false,
                  reason:
                    'Meet audio capture is unavailable because the browser did not expose a system audio track.',
                  details: { missingCapabilities: ['system-audio-track'] },
                };
              }

              const audioStream = new MediaStream(audioTracks);
              const mimeType = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
              ].find(
                (candidate) =>
                  typeof MediaRecorder !== 'undefined' &&
                  typeof MediaRecorder.isTypeSupported === 'function' &&
                  MediaRecorder.isTypeSupported(candidate),
              );
              const recorder = mimeType
                ? new MediaRecorder(audioStream, { mimeType })
                : new MediaRecorder(audioStream);

              sessions[sessionId] = {
                queue: [],
                done: false,
                error: null,
                sampleRate: sampleRate ?? 48_000,
                channels: Math.max(audioTracks.length, 1),
                encoding: recorder.mimeType.startsWith('audio/webm') ? 'webm' : recorder.mimeType.startsWith('audio/ogg') ? 'ogg' : undefined,
                recorder,
                stream,
                audioStream,
              };

              let pendingData = Promise.resolve();
              recorder.ondataavailable = (event) => {
                if (!event.data || event.data.size === 0) {
                  return;
                }
                const activeSession = sessions[sessionId];
                if (!activeSession) {
                  return;
                }
                pendingData = pendingData.then(async () => {
                  const buffer = await event.data.arrayBuffer();
                  activeSession.queue.push(Array.from(new Uint8Array(buffer)));
                }).catch(() => { activeSession.error = 'MediaRecorder data extraction failed.'; });
              };
              recorder.onerror = (event) => {
                const activeSession = sessions[sessionId];
                if (!activeSession) {
                  return;
                }
                activeSession.error =
                  event.error?.message ?? 'Meet MediaRecorder failed.';
                activeSession.done = true;
              };
              recorder.onstop = () => {
                const activeSession = sessions[sessionId];
                if (!activeSession) {
                  return;
                }
                void pendingData.then(() => { activeSession.done = true; });
              };

              const markEnded = () => {
                const activeSession = sessions[sessionId];
                if (!activeSession) {
                  return;
                }
                if (recorder.state !== 'inactive') {
                  recorder.stop();
                }
              };
              audioTracks.forEach((track) => {
                track.onended = markEnded;
              });

              recorder.start(timesliceMs);
              return {
                ok: true,
                sessionId,
                sampleRate: sessions[sessionId].sampleRate,
                channels: sessions[sessionId].channels,
              };
            } catch (error) {
              return {
                ok: false,
                reason:
                  error instanceof Error
                    ? error.message
                    : 'Meet audio capture could not start.',
              };
            }
          },
          {
            sampleRate: options?.sampleRate,
            timesliceMs: MEET_AUDIO_CAPTURE_TIMESLICE_MS,
          },
        );

        if (!startResult.ok || !startResult.sessionId) {
          controller.error(
            createMeetCaptureUnavailableError(
              startResult.reason ?? 'Meet audio capture prerequisites are unavailable.',
              startResult.details,
            ),
          );
          return;
        }

        activeSessionId = startResult.sessionId;

        const poll = async () => {
          if (closed || !activeSessionId) {
            return;
          }

          try {
            const result = await page.evaluate(
              (activeSessionId): MeetCapturePollResult => {
                const w = window as typeof window & {
                  __REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__?: Record<
                    string,
                    {
                      queue: number[][];
                      done: boolean;
                      error: string | null;
                      sampleRate: number;
                      channels: number;
                  encoding?: AudioChunk['encoding'];
                    }
                  >;
                };
                const sessions = w.__REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__ ?? {};
                const activeSession = sessions[activeSessionId];
                if (!activeSession) {
                  return {
                    chunks: [],
                    done: true,
                    error: null,
                    sampleRate: 48_000,
                    channels: 1,
                  };
                }

                const chunks = activeSession.queue.splice(
                  0,
                  activeSession.queue.length,
                );
                const snapshot: MeetCapturePollResult = {
                  chunks,
                  done: activeSession.done && chunks.length === 0,
                  error: activeSession.error,
                  sampleRate: activeSession.sampleRate,
                  channels: activeSession.channels,
                  encoding: activeSession.encoding,
                };
                if (snapshot.done) {
                  const media = activeSession as typeof activeSession & { stream?: MediaStream; audioStream?: MediaStream };
                  media.audioStream?.getTracks().forEach(track => track.stop());
                  media.stream?.getTracks().forEach(track => track.stop());
                  delete sessions[activeSessionId];
                }
                return snapshot;
              },
              activeSessionId,
            );

            if (result.error) {
              closed = true;
              controller.error(
                createMeetCaptureUnavailableError(result.error, {
                  sessionId: activeSessionId,
                }),
              );
              return;
            }

            for (const rawChunk of result.chunks) {
              if (rawChunk.length === 0) {
                continue;
              }
              sawData = true;
              controller.enqueue({
                data: new Uint8Array(rawChunk),
                timestamp: Date.now(),
                sampleRate: result.sampleRate ?? options?.sampleRate ?? 48_000,
                channels: result.channels ?? 1,
                encoding: result.encoding,
              });
            }

            if (result.done) {
              closed = true;
              controller.close();
              stopCapture();
              return;
            }

            activePollTimeout = setTimeout(
              poll,
              MEET_AUDIO_CAPTURE_POLL_INTERVAL_MS,
            );
          } catch (error) {
            closed = true;
            if (sawData) {
              controller.close();
              stopCapture();
              return;
            }

            controller.error(
              createMeetCaptureUnavailableError(
                error instanceof Error
                  ? error.message
                  : 'Meet audio capture could not be read.',
                { sessionId: activeSessionId },
              ),
            );
          }
        };

        await poll();
      } catch (error) {
        controller.error(
          createMeetCaptureUnavailableError(
            error instanceof Error
              ? error.message
              : 'Meet audio capture could not be initialized.',
          ),
        );
      } finally {
        if (closed) {
          clearPendingPoll();
        }
      }
    },
    cancel() {
      if (activePollTimeout) {
        clearTimeout(activePollTimeout);
        activePollTimeout = undefined;
      }
      if (!activeSessionId) {
        return;
      }
      void page
        .evaluate((sessionId) => {
          const w = window as typeof window & {
            __REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__?: Record<
              string,
              {
                recorder?: MediaRecorder;
                stream?: MediaStream;
                audioStream?: MediaStream;
              }
            >;
          };
          const sessions = w.__REC_FN_MEET_AUDIO_CAPTURE_SESSIONS__;
          const activeSession = sessions?.[sessionId];
          if (!activeSession) {
            return;
          }
          if (
            activeSession.recorder &&
            activeSession.recorder.state !== 'inactive'
          ) {
            activeSession.recorder.stop();
          }
          activeSession.audioStream?.getTracks().forEach((track) => track.stop());
          activeSession.stream?.getTracks().forEach((track) => track.stop());
            if (sessions) {
              delete sessions[sessionId];
            }
          }, activeSessionId)
          .catch(() => {});
      activeSessionId = undefined;
    },
  });
}
