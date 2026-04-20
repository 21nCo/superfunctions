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

type InternalBotConfig = BotConfig & {
  __botId?: string;
};

export class ZoomAdapter implements PlatformAdapter {
  readonly platform = 'zoom' as const;

  private readonly sdk: ZoomMeetingSdk;
  private readonly sdkConfig: ZoomMeetingSdkConfig;
  private participantTracker: ParticipantTracker;
  private chatTracker: ChatTracker;
  private connected = false;
  private botId = '';
  private joinedAt?: string;
  private endedAt?: string;

  constructor(config: ZoomAdapterConfig) {
    this.sdk = config.sdk;
    this.sdkConfig = config.sdkConfig;
    this.participantTracker = createParticipantTracker(this.sdk);
    this.chatTracker = createChatTracker(this.sdk);

    this.sdk.on('meeting-ended', () => {
      this.connected = false;
      this.endedAt = this.endedAt ?? new Date().toISOString();
    });
  }

  async join(meetingUrl: string, config: BotConfig): Promise<void> {
    await this.sdk.init(this.sdkConfig);
    this.botId = (config as InternalBotConfig).__botId ?? this.botId;
    this.participantTracker.setBotId(this.botId);
    this.joinedAt = new Date().toISOString();
    this.endedAt = undefined;

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
    this.endedAt = this.endedAt ?? new Date().toISOString();
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
    return snapshotParticipants(this.sdk, this.botId);
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
      botId: this.botId,
      title: info.meetingTopic,
      startTime: this.joinedAt,
      endTime: this.endedAt,
      platform: 'zoom',
      chatMessages: this.chatTracker.getMessages(),
    };
  }

  isConnected(): boolean {
    return this.connected;
  }
}
