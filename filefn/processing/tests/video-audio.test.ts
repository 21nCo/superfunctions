import { describe, it, expect, vi } from 'vitest';
import {
  createVideoProcessor,
  createAudioProcessor,
  supportsProcessor,
  VIDEO_SUPPORTED_MIME_TYPES,
  AUDIO_SUPPORTED_MIME_TYPES,
} from '../src/index.js';

function createMockVideoData(size: number = 1000): Uint8Array {
  const data = new Uint8Array(size);
  const header = new TextEncoder().encode('MOCK_VIDEO_DATA');
  data.set(header, 0);
  for (let i = header.length; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

function createMockAudioData(size: number = 500): Uint8Array {
  const data = new Uint8Array(size);
  const header = new TextEncoder().encode('MOCK_AUDIO_DATA');
  data.set(header, 0);
  for (let i = header.length; i < size; i++) {
    data[i] = Math.floor(Math.random() * 256);
  }
  return data;
}

describe('Video Processor', () => {
  describe('Contract compliance', () => {
    it('should export Processor-compatible video processor', () => {
      const processor = createVideoProcessor();
      expect(processor).toBeDefined();
      expect(processor.name).toBe('video');
      expect(processor.supportedMimeTypes).toEqual(VIDEO_SUPPORTED_MIME_TYPES);
      expect(typeof processor.process).toBe('function');
    });

    it('should support correct MIME types', () => {
      const processor = createVideoProcessor();
      expect(supportsProcessor(processor, 'video/mp4')).toBe(true);
      expect(supportsProcessor(processor, 'video/webm')).toBe(true);
      expect(supportsProcessor(processor, 'video/ogg')).toBe(true);
      expect(supportsProcessor(processor, 'video/quicktime')).toBe(true);
      expect(supportsProcessor(processor, 'video/x-matroska')).toBe(true);
      expect(supportsProcessor(processor, 'image/png')).toBe(false);
      expect(supportsProcessor(processor, 'audio/mpeg')).toBe(false);
    });
  });

  describe('Video processing', () => {
    it('should reject unsupported MIME types', async () => {
      const processor = createVideoProcessor();
      const getData = vi.fn();

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/image.png',
          mimeType: 'image/png',
          size: 1000,
          fileName: 'image.png',
        },
        getData
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported MIME type');
      expect(getData).not.toHaveBeenCalled();
    });

    it('should generate poster thumbnail by default', async () => {
      const processor = createVideoProcessor({
        generatePoster: true,
        posterOptions: {
          timestamp: 2.5,
          width: 1280,
          height: 720,
          format: 'jpeg',
          quality: 85,
        },
        transcode: false,
      });

      const videoData = createMockVideoData(5000);
      const getData = vi.fn().mockResolvedValue(videoData);

      const result = await processor.process(
        {
          fileId: 'file_001',
          versionId: 'ver_001',
          storageKey: 'test/video.mp4',
          mimeType: 'video/mp4',
          size: videoData.length,
          fileName: 'video.mp4',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].kind).toBe('video-poster');
      expect(result.artifacts[0].mimeType).toBe('image/jpeg');
      expect(result.artifacts[0].storageKey).toBe('test/video-poster.jpg');

      expect(result.artifacts[0].metadata).toMatchObject({
        timestamp: 2.5,
        width: 1280,
        height: 720,
        format: 'jpeg',
        quality: 85,
        sourceFileId: 'file_001',
        sourceVersionId: 'ver_001',
      });

      expect(result.artifacts[0].data.length).toBeGreaterThan(0);
    });

    it('should generate poster in PNG format', async () => {
      const processor = createVideoProcessor({
        generatePoster: true,
        posterOptions: {
          format: 'png',
          width: 640,
          height: 360,
        },
        transcode: false,
      });

      const videoData = createMockVideoData(5000);
      const getData = vi.fn().mockResolvedValue(videoData);

      const result = await processor.process(
        {
          fileId: 'file_002',
          versionId: 'ver_001',
          storageKey: 'test/video.webm',
          mimeType: 'video/webm',
          size: videoData.length,
          fileName: 'video.webm',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].kind).toBe('video-poster');
      expect(result.artifacts[0].mimeType).toBe('image/png');
      expect(result.artifacts[0].storageKey).toBe('test/video-poster.png');
    });

    it('should transcode video', async () => {
      const processor = createVideoProcessor({
        generatePoster: false,
        transcode: true,
        transcodeOptions: {
          codec: 'h264',
          resolution: '720p',
          bitrate: '2M',
          fps: 30,
        },
      });

      const videoData = createMockVideoData(10000);
      const getData = vi.fn().mockResolvedValue(videoData);

      const result = await processor.process(
        {
          fileId: 'file_003',
          versionId: 'ver_001',
          storageKey: 'test/original.mp4',
          mimeType: 'video/mp4',
          size: videoData.length,
          fileName: 'original.mp4',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].kind).toBe('video-transcoded-720p');
      expect(result.artifacts[0].mimeType).toBe('video/mp4');
      expect(result.artifacts[0].storageKey).toBe('test/original-720p.mp4');

      expect(result.artifacts[0].metadata).toMatchObject({
        codec: 'h264',
        resolution: '720p',
        bitrate: '2M',
        fps: 30,
        sourceFileId: 'file_003',
        sourceVersionId: 'ver_001',
      });

      expect(result.artifacts[0].data.length).toBeLessThan(videoData.length);
    });

    it('should transcode to VP9/WebM', async () => {
      const processor = createVideoProcessor({
        generatePoster: false,
        transcode: true,
        transcodeOptions: {
          codec: 'vp9',
          resolution: '1080p',
        },
      });

      const videoData = createMockVideoData(10000);
      const getData = vi.fn().mockResolvedValue(videoData);

      const result = await processor.process(
        {
          fileId: 'file_004',
          versionId: 'ver_001',
          storageKey: 'test/video.mp4',
          mimeType: 'video/mp4',
          size: videoData.length,
          fileName: 'video.mp4',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].kind).toBe('video-transcoded-1080p');
      expect(result.artifacts[0].mimeType).toBe('video/webm');
      expect(result.artifacts[0].storageKey).toBe('test/video-1080p.webm');
    });

    it('should extract video metadata', async () => {
      const processor = createVideoProcessor({
        generatePoster: false,
        transcode: false,
        extractMetadata: true,
      });

      const videoData = createMockVideoData(5000);
      const getData = vi.fn().mockResolvedValue(videoData);

      const result = await processor.process(
        {
          fileId: 'file_005',
          versionId: 'ver_001',
          storageKey: 'test/video.mp4',
          mimeType: 'video/mp4',
          size: videoData.length,
          fileName: 'video.mp4',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].kind).toBe('video-metadata');
      expect(result.artifacts[0].mimeType).toBe('application/json');
      expect(result.artifacts[0].storageKey).toBe('test/video-metadata.json');

      const metadata = JSON.parse(new TextDecoder().decode(result.artifacts[0].data));
      expect(metadata).toHaveProperty('duration');
      expect(metadata).toHaveProperty('width');
      expect(metadata).toHaveProperty('height');
      expect(metadata).toHaveProperty('codec');
      expect(metadata).toHaveProperty('fps');
      expect(metadata).toHaveProperty('bitrate');
      expect(metadata).toHaveProperty('audioCodec');
    });

    it('should generate all artifacts when all options enabled', async () => {
      const processor = createVideoProcessor({
        generatePoster: true,
        transcode: true,
        extractMetadata: true,
      });

      const videoData = createMockVideoData(10000);
      const getData = vi.fn().mockResolvedValue(videoData);

      const result = await processor.process(
        {
          fileId: 'file_006',
          versionId: 'ver_001',
          storageKey: 'test/complete.mp4',
          mimeType: 'video/mp4',
          size: videoData.length,
          fileName: 'complete.mp4',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(3);

      const kinds = result.artifacts.map((a) => a.kind).sort();
      expect(kinds).toEqual(['video-metadata', 'video-poster', 'video-transcoded-720p']);
    });

    it('should handle getData errors gracefully', async () => {
      const processor = createVideoProcessor();
      const getData = vi.fn().mockRejectedValue(new Error('Storage failure'));

      const result = await processor.process(
        {
          fileId: 'file_007',
          versionId: 'ver_001',
          storageKey: 'test/error.mp4',
          mimeType: 'video/mp4',
          size: 1000,
          fileName: 'error.mp4',
        },
        getData
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Storage failure');
      expect(result.artifacts).toHaveLength(0);
    });
  });
});

describe('Audio Processor', () => {
  describe('Contract compliance', () => {
    it('should export Processor-compatible audio processor', () => {
      const processor = createAudioProcessor();
      expect(processor).toBeDefined();
      expect(processor.name).toBe('audio');
      expect(processor.supportedMimeTypes).toEqual(AUDIO_SUPPORTED_MIME_TYPES);
      expect(typeof processor.process).toBe('function');
    });

    it('should support correct MIME types', () => {
      const processor = createAudioProcessor();
      expect(supportsProcessor(processor, 'audio/mpeg')).toBe(true);
      expect(supportsProcessor(processor, 'audio/mp3')).toBe(true);
      expect(supportsProcessor(processor, 'audio/mp4')).toBe(true);
      expect(supportsProcessor(processor, 'audio/aac')).toBe(true);
      expect(supportsProcessor(processor, 'audio/ogg')).toBe(true);
      expect(supportsProcessor(processor, 'audio/opus')).toBe(true);
      expect(supportsProcessor(processor, 'audio/wav')).toBe(true);
      expect(supportsProcessor(processor, 'audio/flac')).toBe(true);
      expect(supportsProcessor(processor, 'video/mp4')).toBe(false);
      expect(supportsProcessor(processor, 'image/jpeg')).toBe(false);
    });
  });

  describe('Audio processing', () => {
    it('should reject unsupported MIME types', async () => {
      const processor = createAudioProcessor();
      const getData = vi.fn();

      const result = await processor.process(
        {
          fileId: 'file_008',
          versionId: 'ver_001',
          storageKey: 'test/video.mp4',
          mimeType: 'video/mp4',
          size: 1000,
          fileName: 'video.mp4',
        },
        getData
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported MIME type');
      expect(getData).not.toHaveBeenCalled();
    });

    it('should transcode audio by default', async () => {
      const processor = createAudioProcessor({
        transcode: true,
        transcodeOptions: {
          codec: 'aac',
          bitrate: '128k',
          sampleRate: 44100,
          channels: 2,
        },
      });

      const audioData = createMockAudioData(5000);
      const getData = vi.fn().mockResolvedValue(audioData);

      const result = await processor.process(
        {
          fileId: 'file_009',
          versionId: 'ver_001',
          storageKey: 'test/audio.mp3',
          mimeType: 'audio/mpeg',
          size: audioData.length,
          fileName: 'audio.mp3',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].kind).toBe('audio-transcoded-aac');
      expect(result.artifacts[0].mimeType).toBe('audio/mp4');
      expect(result.artifacts[0].storageKey).toBe('test/audio-aac.m4a');

      expect(result.artifacts[0].metadata).toMatchObject({
        codec: 'aac',
        bitrate: '128k',
        sampleRate: 44100,
        channels: 2,
        sourceFileId: 'file_009',
        sourceVersionId: 'ver_001',
      });

      expect(result.artifacts[0].data.length).toBeGreaterThan(0);
    });

    it('should transcode to MP3', async () => {
      const processor = createAudioProcessor({
        transcode: true,
        transcodeOptions: {
          codec: 'mp3',
          bitrate: '192k',
        },
      });

      const audioData = createMockAudioData(5000);
      const getData = vi.fn().mockResolvedValue(audioData);

      const result = await processor.process(
        {
          fileId: 'file_010',
          versionId: 'ver_001',
          storageKey: 'test/audio.flac',
          mimeType: 'audio/flac',
          size: audioData.length,
          fileName: 'audio.flac',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].kind).toBe('audio-transcoded-mp3');
      expect(result.artifacts[0].mimeType).toBe('audio/mpeg');
      expect(result.artifacts[0].storageKey).toBe('test/audio-mp3.mp3');
    });

    it('should transcode to Opus', async () => {
      const processor = createAudioProcessor({
        transcode: true,
        transcodeOptions: {
          codec: 'opus',
          bitrate: '96k',
        },
      });

      const audioData = createMockAudioData(5000);
      const getData = vi.fn().mockResolvedValue(audioData);

      const result = await processor.process(
        {
          fileId: 'file_011',
          versionId: 'ver_001',
          storageKey: 'test/audio.wav',
          mimeType: 'audio/wav',
          size: audioData.length,
          fileName: 'audio.wav',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].kind).toBe('audio-transcoded-opus');
      expect(result.artifacts[0].mimeType).toBe('audio/opus');
      expect(result.artifacts[0].storageKey).toBe('test/audio-opus.opus');
    });

    it('should extract audio metadata', async () => {
      const processor = createAudioProcessor({
        transcode: false,
        extractMetadata: true,
      });

      const audioData = createMockAudioData(5000);
      const getData = vi.fn().mockResolvedValue(audioData);

      const result = await processor.process(
        {
          fileId: 'file_012',
          versionId: 'ver_001',
          storageKey: 'test/song.mp3',
          mimeType: 'audio/mpeg',
          size: audioData.length,
          fileName: 'song.mp3',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].kind).toBe('audio-metadata');
      expect(result.artifacts[0].mimeType).toBe('application/json');
      expect(result.artifacts[0].storageKey).toBe('test/song-metadata.json');

      const metadata = JSON.parse(new TextDecoder().decode(result.artifacts[0].data));
      expect(metadata).toHaveProperty('duration');
      expect(metadata).toHaveProperty('codec');
      expect(metadata).toHaveProperty('bitrate');
      expect(metadata).toHaveProperty('sampleRate');
      expect(metadata).toHaveProperty('channels');
      expect(metadata).toHaveProperty('title');
      expect(metadata).toHaveProperty('artist');
      expect(metadata).toHaveProperty('album');
    });

    it('should generate waveform data', async () => {
      const processor = createAudioProcessor({
        transcode: false,
        generateWaveform: true,
      });

      const audioData = createMockAudioData(5000);
      const getData = vi.fn().mockResolvedValue(audioData);

      const result = await processor.process(
        {
          fileId: 'file_013',
          versionId: 'ver_001',
          storageKey: 'test/audio.mp3',
          mimeType: 'audio/mpeg',
          size: audioData.length,
          fileName: 'audio.mp3',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].kind).toBe('audio-waveform');
      expect(result.artifacts[0].mimeType).toBe('application/json');
      expect(result.artifacts[0].storageKey).toBe('test/audio-waveform.json');

      const waveform = JSON.parse(new TextDecoder().decode(result.artifacts[0].data));
      expect(waveform).toHaveProperty('samples');
      expect(waveform).toHaveProperty('peakAmplitude');
      expect(waveform).toHaveProperty('duration');
      expect(Array.isArray(waveform.samples)).toBe(true);
      expect(waveform.samples.length).toBeGreaterThan(0);
    });

    it('should generate deterministic waveform output for the same input', async () => {
      const processor = createAudioProcessor({
        transcode: false,
        generateWaveform: true,
      });

      const audioData = createMockAudioData(5000);
      const input = {
        fileId: 'file_013_repeat',
        versionId: 'ver_001',
        storageKey: 'test/audio-repeat.mp3',
        mimeType: 'audio/mpeg',
        size: audioData.length,
        fileName: 'audio-repeat.mp3',
      };

      const first = await processor.process(input, vi.fn().mockResolvedValue(audioData));
      const second = await processor.process(input, vi.fn().mockResolvedValue(audioData));

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(first.artifacts[0].data).toEqual(second.artifacts[0].data);
    });

    it('should generate all artifacts when all options enabled', async () => {
      const processor = createAudioProcessor({
        transcode: true,
        extractMetadata: true,
        generateWaveform: true,
      });

      const audioData = createMockAudioData(5000);
      const getData = vi.fn().mockResolvedValue(audioData);

      const result = await processor.process(
        {
          fileId: 'file_014',
          versionId: 'ver_001',
          storageKey: 'test/complete.mp3',
          mimeType: 'audio/mpeg',
          size: audioData.length,
          fileName: 'complete.mp3',
        },
        getData
      );

      expect(result.success).toBe(true);
      expect(result.artifacts).toHaveLength(3);

      const kinds = result.artifacts.map((a) => a.kind).sort();
      expect(kinds).toEqual(['audio-metadata', 'audio-transcoded-aac', 'audio-waveform']);
    });

    it('should handle different bitrates correctly', async () => {
      const lowBitrate = createAudioProcessor({
        transcode: true,
        transcodeOptions: { codec: 'aac', bitrate: '64k' },
      });

      const highBitrate = createAudioProcessor({
        transcode: true,
        transcodeOptions: { codec: 'aac', bitrate: '256k' },
      });

      const audioData = createMockAudioData(10000);
      const getDataLow = vi.fn().mockResolvedValue(audioData);
      const getDataHigh = vi.fn().mockResolvedValue(audioData);

      const resultLow = await lowBitrate.process(
        {
          fileId: 'file_015',
          versionId: 'ver_001',
          storageKey: 'test/audio.mp3',
          mimeType: 'audio/mpeg',
          size: audioData.length,
          fileName: 'audio.mp3',
        },
        getDataLow
      );

      const resultHigh = await highBitrate.process(
        {
          fileId: 'file_016',
          versionId: 'ver_001',
          storageKey: 'test/audio.mp3',
          mimeType: 'audio/mpeg',
          size: audioData.length,
          fileName: 'audio.mp3',
        },
        getDataHigh
      );

      expect(resultLow.success).toBe(true);
      expect(resultHigh.success).toBe(true);

      expect(resultLow.artifacts[0].data.length).toBeLessThan(resultHigh.artifacts[0].data.length);
    });

    it('falls back safely when bitrate is malformed', async () => {
      const processor = createAudioProcessor({
        transcode: true,
        transcodeOptions: { codec: 'aac', bitrate: 'oops' },
      });

      const audioData = createMockAudioData(10000);
      const result = await processor.process(
        {
          fileId: 'file_016_bad_bitrate',
          versionId: 'ver_001',
          storageKey: 'test/audio.wav',
          mimeType: 'audio/wav',
          size: audioData.length,
          fileName: 'audio.wav',
        },
        vi.fn().mockResolvedValue(audioData),
      );

      expect(result.success).toBe(true);
      expect(result.artifacts[0].metadata).toMatchObject({ bitrate: 'oops' });
      expect(result.artifacts[0].data.length).toBeGreaterThan(0);
    });

    it('should handle getData errors gracefully', async () => {
      const processor = createAudioProcessor();
      const getData = vi.fn().mockRejectedValue(new Error('Download failed'));

      const result = await processor.process(
        {
          fileId: 'file_017',
          versionId: 'ver_001',
          storageKey: 'test/error.mp3',
          mimeType: 'audio/mpeg',
          size: 1000,
          fileName: 'error.mp3',
        },
        getData
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Download failed');
      expect(result.artifacts).toHaveLength(0);
    });
  });
});
