export {
  BrowserAutomationAdapter,
  createBrowserSession,
  joinBrowserMeeting,
  leaveBrowserMeeting,
} from './session.js';
export type {
  BrowserAdapterConfig,
  BrowserSession,
  BrowserSessionFactory,
  BrowserSessionFactoryConfig,
  BrowserPlatformHooks,
  BrowserJoinBehavior,
} from './session.js';

export { createBrowserParticipantTracker } from './participants.js';
export type {
  BrowserParticipantEntry,
  BrowserParticipantTracker,
  BrowserParticipantTrackerLike,
  BrowserParticipantTrackerOptions,
} from './participants.js';

export { createBrowserChatTracker } from './chat.js';
export type {
  BrowserChatEntry,
  BrowserChatTracker,
  BrowserChatTrackerLike,
  BrowserChatTrackerOptions,
} from './chat.js';

export { createBrowserAudioStream } from './audio-capture.js';
export type {
  BrowserAudioSupport,
  BrowserAudioSupportEvaluator,
  BrowserAudioStreamOptions,
} from './audio-capture.js';
