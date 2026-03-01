import type { ChatMessage } from 'recfn';
import type { ZoomMeetingSdk, ZoomChatMessageInfo } from './meeting-sdk.js';

export interface ChatTracker {
  getMessages(): ChatMessage[];
  onMessage(cb: (msg: ChatMessage) => void): void;
  send(text: string): Promise<void>;
}

function toChatMessage(info: ZoomChatMessageInfo): ChatMessage {
  return {
    participantId: info.senderId,
    text: info.message,
    timestamp: new Date(info.timestamp).toISOString(),
  };
}

export function createChatTracker(sdk: ZoomMeetingSdk): ChatTracker {
  const messages: ChatMessage[] = [];
  const messageCallbacks: Array<(msg: ChatMessage) => void> = [];

  sdk.on('chat-message', (info: ZoomChatMessageInfo) => {
    const msg = toChatMessage(info);
    messages.push(msg);
    for (const cb of messageCallbacks) {
      cb(msg);
    }
  });

  return {
    getMessages(): ChatMessage[] {
      return [...messages];
    },

    onMessage(cb: (msg: ChatMessage) => void): void {
      messageCallbacks.push(cb);
    },

    async send(text: string): Promise<void> {
      await sdk.sendChat(text);
    },
  };
}
