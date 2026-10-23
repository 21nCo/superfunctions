export interface ZoomMeetingSdkConfig {
  sdkKey: string;
  sdkSecret: string;
}

export interface ZoomJoinOptions {
  meetingNumber: string;
  password?: string;
  displayName: string;
}

export interface ZoomParticipantInfo {
  participantId: string;
  name: string;
  email?: string;
  isHost: boolean;
}

export interface ZoomChatMessageInfo {
  senderId: string;
  senderName: string;
  message: string;
  timestamp: number;
}

export interface ZoomAudioFrame {
  buffer: Uint8Array;
  sampleRate: number;
  channels: number;
  participantId?: string;
}

export interface ZoomVideoFrame {
  buffer: Uint8Array;
  width: number;
  height: number;
}

export interface ZoomMeetingInfo {
  meetingNumber: string;
  meetingTopic: string;
  hostName?: string;
}

export interface ZoomMeetingSdk {
  init(config: ZoomMeetingSdkConfig): Promise<void>;
  join(options: ZoomJoinOptions): Promise<void>;
  leave(): Promise<void>;
  getMeetingInfo(): ZoomMeetingInfo;
  getParticipants(): ZoomParticipantInfo[];
  sendChat(message: string): Promise<void>;
  startRawAudio(): void;
  stopRawAudio(): void;
  startRawVideo(): void;
  stopRawVideo(): void;
  isInMeeting(): boolean;
  on(event: 'audio-frame', cb: (frame: ZoomAudioFrame) => void): void;
  on(
    event: 'participant-audio-frame',
    cb: (frame: ZoomAudioFrame) => void,
  ): void;
  on(event: 'video-frame', cb: (frame: ZoomVideoFrame) => void): void;
  on(
    event: 'participant-joined',
    cb: (info: ZoomParticipantInfo) => void,
  ): void;
  on(
    event: 'participant-left',
    cb: (info: { participantId: string }) => void,
  ): void;
  on(event: 'chat-message', cb: (msg: ZoomChatMessageInfo) => void): void;
  on(event: 'meeting-ended', cb: () => void): void;
  off(event: string, cb: (...args: unknown[]) => void): void;
}

export function parseMeetingUrl(url: string): {
  meetingNumber: string;
  password?: string;
} {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split('/');
  const jIndex = pathParts.indexOf('j');
  let meetingNumber = '';

  if (jIndex !== -1 && pathParts[jIndex + 1]) {
    meetingNumber = pathParts[jIndex + 1].replace(/\D/g, '');
  }

  if (!meetingNumber) {
    for (const part of pathParts) {
      const digits = part.replace(/\D/g, '');
      if (digits.length >= 9) {
        meetingNumber = digits;
        break;
      }
    }
  }

  const password = parsed.searchParams.get('pwd') ?? undefined;

  return { meetingNumber, password };
}
