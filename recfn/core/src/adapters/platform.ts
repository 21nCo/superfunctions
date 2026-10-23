import type {
  AudioChunk,
  BotConfig,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Platform,
  VideoChunk,
} from '../types.js';

export interface PlatformAdapter {
  readonly platform: Platform;
  join(meetingUrl: string, config: BotConfig): Promise<void>;
  leave(): Promise<void>;
  getAudioStream(): ReadableStream<AudioChunk>;
  getVideoStream?(): ReadableStream<VideoChunk>;
  getParticipants(): Promise<Participant[]>;
  onParticipantJoin(cb: (p: Participant) => void): void;
  onParticipantLeave(cb: (id: string) => void): void;
  getChatMessages(): Promise<ChatMessage[]>;
  onChatMessage(cb: (msg: ChatMessage) => void): void;
  sendChatMessage(text: string): Promise<void>;
  getMetadata(): Promise<MeetingMetadata>;
  isConnected(): boolean;
}
