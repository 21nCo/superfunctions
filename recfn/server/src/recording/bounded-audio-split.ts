import { createError, ErrorCode, type AudioChunk } from '@recfn/core';

/** Both consumers exert backpressure; one slow consumer cannot grow a tee queue indefinitely. */
export function splitAudio(stream: ReadableStream<AudioChunk>, signal: AbortSignal, limit = 8 * 1024 * 1024): [ReadableStream<AudioChunk>, ReadableStream<AudioChunk>] {
  const reader = stream.getReader();
  const controllers: Array<ReadableStreamDefaultController<AudioChunk> | undefined> = [];
  let pending: AudioChunk | undefined;
  let busy = false, ended = false, ready = false;
  const stop = (error?: unknown) => {
    if (ended) return;
    ended = true;
    signal.removeEventListener('abort', abort);
    for (const controller of controllers) if (controller) error ? controller.error(error) : controller.close();
    void reader.cancel(error).catch(() => {}).finally(() => reader.releaseLock());
    pending = undefined;
  };
  const abort = () => stop(createError(ErrorCode.RECORDING_FINALIZATION_FAILED, 'Audio split was canceled.'));
  async function pump() {
    if (busy || ended || !ready) return;
    busy = true;
    try {
      while (!ended) {
        let active = controllers.filter((c): c is ReadableStreamDefaultController<AudioChunk> => !!c);
        if (!active.length) { stop(); return; }
        if (!pending) {
          if (active.some(c => (c.desiredSize ?? 0) <= 0)) return;
          const result = await reader.read();
          if (ended) return;
          if (result.done) { stop(); return; }
          pending = result.value;
          if (pending.data.byteLength > limit) throw createError(ErrorCode.RECORDING_FINALIZATION_FAILED, 'Audio split chunk exceeds buffer limit.');
        }
        active = controllers.filter((c): c is ReadableStreamDefaultController<AudioChunk> => !!c);
        if (!active.length) { stop(); return; }
        if (active.some(c => (c.desiredSize ?? 0) < pending!.data.byteLength)) return;
        for (const controller of active) controller.enqueue({ ...pending, data: new Uint8Array(pending.data) });
        pending = undefined;
      }
    } catch (error) { stop(error); }
    finally { busy = false; }
  }
  const branches = [0, 1].map(index => new ReadableStream<AudioChunk>({
    start(controller) { controllers[index] = controller; },
    pull() { return pump(); },
    cancel() { controllers[index] = undefined; return pump(); },
  }, { highWaterMark: limit, size: value => value.data.byteLength }));
  ready = true;
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort(); else void pump();
  return branches as [ReadableStream<AudioChunk>, ReadableStream<AudioChunk>];
}
