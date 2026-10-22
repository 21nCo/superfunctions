import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMeetAudioStream } from '../../platforms/meet/src/audio-capture.js';
import { createTeamsAudioStream } from '../../platforms/teams/src/audio-capture.js';
afterEach(() => vi.unstubAllGlobals());
describe.each([['Meet', createMeetAudioStream], ['Teams', createTeamsAudioStream]] as const)('%s MediaRecorder completion', (_name, createStream) => {
  it('preserves final asynchronous blobs in event order and declares the container', async () => {
    let recorder: any;
    class Recorder {
      static isTypeSupported() { return true; }
      mimeType = 'audio/webm;codecs=opus'; state = 'recording';
      ondataavailable: any; onstop: any;
      constructor() { recorder = this; }
      start() {}
      stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    const track = { stop: vi.fn(), onended: null };
    class Media {
      getTracks() { return [track]; }
      getAudioTracks() { return [track]; }
    }
    vi.stubGlobal('window', { AudioContext: class {} });
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: async () => new Media() } });
    vi.stubGlobal('MediaRecorder', Recorder);
    vi.stubGlobal('MediaStream', Media);
    const page = { evaluate: async (fn: any, args: any) => fn(args) } as any;
    const stream = createStream(page);
    await vi.waitFor(() => expect(recorder).toBeDefined());
    let finish!: (value: ArrayBuffer) => void;
    const delayed = new Promise<ArrayBuffer>(resolve => { finish = resolve; });
    recorder.ondataavailable({ data: { size: 2, arrayBuffer: () => delayed } });
    recorder.ondataavailable({ data: { size: 2, arrayBuffer: async () => new Uint8Array([3, 4]).buffer } });
    recorder.stop();
    const reader = stream.getReader();
    const result = reader.read();
    finish(new Uint8Array([1, 2]).buffer);
    const first = await result;
    const second = await reader.read();
    expect(first.value?.encoding).toBe('webm');
    expect(Array.from(first.value!.data)).toEqual([1, 2]);
    expect(Array.from(second.value!.data)).toEqual([3, 4]);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(track.stop).toHaveBeenCalled();
  });
});
