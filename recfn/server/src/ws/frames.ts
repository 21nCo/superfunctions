export type WebSocketFrameType =
  | 'segment'
  | 'participant_joined'
  | 'participant_left'
  | 'status'
  | 'error'
  | 'ping'
  | 'pong';

export interface WebSocketFrame<T = any> {
  type: WebSocketFrameType;
  data?: T;
}

export interface ErrorFrameData {
  code: string;
  message: string;
}

export function createFrame<T>(type: WebSocketFrameType, data?: T): string {
  if (data === undefined) {
    return JSON.stringify({ type });
  }
  return JSON.stringify({ type, data });
}

export function createErrorFrame(code: string, message: string): string {
  return createFrame<ErrorFrameData>('error', { code, message });
}
