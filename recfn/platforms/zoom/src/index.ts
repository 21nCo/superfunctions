import type {
  PlatformAdapter,
  BotConfig,
  Participant,
  ChatMessage,
  MeetingMetadata,
  AudioChunk,
  VideoChunk,
} from 'recfn';
import type { ZoomMeetingSdk, ZoomMeetingSdkConfig } from './meeting-sdk.js';
import { parseMeetingUrl } from './meeting-sdk.js';
import { createAudioStream } from './audio-capture.js';
import { createVideoStream } from './video-capture.js';
import {
  createParticipantTracker,
  snapshotParticipants,
  type ParticipantTracker,
} from './participants.js';
import { createChatTracker, type ChatTracker } from './chat.js';

export { parseMeetingUrl } from './meeting-sdk.js';
export type { ZoomMeetingSdk, ZoomMeetingSdkConfig } from './meeting-sdk.js';
export { createAudioStream, createPerParticipantAudioStream } from './audio-capture.js';
export { createVideoStream } from './video-capture.js';
export { createParticipantTracker, snapshotParticipants } from './participants.js';
export { createChatTracker } from './chat.js';

export interface ZoomAdapterConfig {
  sdk: ZoomMeetingSdk;
  sdkConfig: ZoomMeetingSdkConfig;
}

export class ZoomAdapter implements PlatformAdapter {
  readonly platform = 'zoom' as const;

  private readonly sdk: ZoomMeetingSdk;
  private readonly sdkConfig: ZoomMeetingSdkConfig;
  private participantTracker: ParticipantTracker;
  private chatTracker: ChatTracker;
  private connected = false;

  constructor(config: ZoomAdapterConfig) {
    this.sdk = config.sdk;
    this.sdkConfig = config.sdkConfig;
    this.participantTracker = createParticipantTracker(this.sdk);
    this.chatTracker = createChatTracker(this.sdk);

    this.sdk.on('meeting-ended', () => {
      this.connected = false;
    });
  }

  async join(meetingUrl: string, config: BotConfig): Promise<void> {
    await this.sdk.init(this.sdkConfig);

    const { meetingNumber, password } = parseMeetingUrl(meetingUrl);
    const displayName = config.displayName ?? 'RecFn Bot';

    await this.sdk.join({
      meetingNumber,
      password,
      displayName,
    });

    this.connected = true;
    this.sdk.startRawAudio();
    this.sdk.startRawVideo();
  }

  async leave(): Promise<void> {
    this.sdk.stopRawAudio();
    this.sdk.stopRawVideo();
    await this.sdk.leave();
    this.connected = false;
  }

  getAudioStream(): ReadableStream<AudioChunk> {
    return createAudioStream(this.sdk);
  }

  getVideoStream(): ReadableStream<VideoChunk> {
    return createVideoStream(this.sdk);
  }

  async getParticipants(): Promise<Participant[]> {
    const tracked = this.participantTracker.getAll();
    if (tracked.length > 0) {
      return tracked;
    }
    return snapshotParticipants(this.sdk, '');
  }

  onParticipantJoin(cb: (p: Participant) => void): void {
    this.participantTracker.onJoin(cb);
  }

  onParticipantLeave(cb: (id: string) => void): void {
    this.participantTracker.onLeave(cb);
  }

  async getChatMessages(): Promise<ChatMessage[]> {
    return this.chatTracker.getMessages();
  }

  onChatMessage(cb: (msg: ChatMessage) => void): void {
    this.chatTracker.onMessage(cb);
  }

  async sendChatMessage(text: string): Promise<void> {
    await this.chatTracker.send(text);
  }

  async getMetadata(): Promise<MeetingMetadata> {
    const info = this.sdk.getMeetingInfo();
    return {
      id: info.meetingNumber,
      botId: '',
      title: info.meetingTopic,
      platform: 'zoom',
      chatMessages: this.chatTracker.getMessages(),
    };
  }

  isConnected(): boolean {
    return this.connected;
  }
}
