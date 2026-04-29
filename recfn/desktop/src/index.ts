/**
 * RecFn Desktop Capture SDK.
 * System audio + screen capture, local Whisper transcription, server upload.
 */

export {
  getCaptureStreams,
  stopCaptureStreams,
  createMockCaptureProvider,
  type CaptureProvider,
  type CaptureSource,
  type CaptureStreams,
} from './capture.js';

export {
  recordStreams,
  recordStreamsWithMock,
  createMockRecorder,
  type RecorderOptions,
  type RecorderResult,
  type StreamRecorder,
} from './recorder.js';

export {
  transcribeWithWhisper,
  buildTranscript,
  type TranscriberOptions,
  type TranscriberResult,
} from './transcriber.js';

export { uploadRecording, type UploadOptions } from './uploader.js';

export {
  MeetingDetector,
  classifyMeetingSignals,
  createStaticMeetingSignalProvider,
  type MeetingDetection,
  type MeetingDetectionEvent,
  type MeetingDetectionEventType,
  type MeetingDetectionState,
  type MeetingDetectorOptions,
  type MeetingPlatform,
  type MeetingSignal,
  type MeetingSignalProvider,
  type MeetingSignalSource,
} from './meeting-detection.js';
