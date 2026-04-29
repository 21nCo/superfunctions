export type MeetingPlatform = 'google-meet' | 'zoom' | 'unknown';

export type MeetingSignalSource =
  | 'browser-tab'
  | 'window'
  | 'process'
  | 'capture-source'
  | 'audio'
  | 'calendar';

export type MeetingDetectionState = 'candidate' | 'in_meeting' | 'ended';

export interface MeetingSignal {
  source: MeetingSignalSource;
  title?: string;
  url?: string;
  appName?: string;
  processName?: string;
  sourceId?: string;
  isActive?: boolean;
  timestamp?: number;
}

export interface MeetingDetection {
  id: string;
  platform: MeetingPlatform;
  state: MeetingDetectionState;
  confidence: number;
  signals: MeetingSignal[];
  meetingCode?: string;
  meetingUrl?: string;
  title?: string;
  appName?: string;
  processName?: string;
  sourceId?: string;
  detectedAt: number;
  lastSeenAt: number;
}

export interface MeetingSignalProvider {
  snapshot(): Promise<MeetingSignal[]>;
}

export interface MeetingDetectorOptions {
  minConfidence?: number;
  stableSnapshots?: number;
  endedAfterMisses?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

export type MeetingDetectionEventType =
  | 'meeting.candidate'
  | 'meeting.started'
  | 'meeting.updated'
  | 'meeting.ended';

export interface MeetingDetectionEvent {
  type: MeetingDetectionEventType;
  meeting: MeetingDetection;
}

type MeetingDetectionListener = (event: MeetingDetectionEvent) => void;

interface ScoredSignal {
  platform: MeetingPlatform;
  confidence: number;
  meetingCode?: string;
  meetingUrl?: string;
  title?: string;
  appName?: string;
  processName?: string;
  sourceId?: string;
  signal: MeetingSignal;
}

const GOOGLE_MEET_CODE_RE = /\b([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;
const ZOOM_MEETING_NUMBER_RE = /\b(\d{9,12})\b/;
const ZOOM_HOST_RE = /(^|\.)zoom\.(us|com|com\.cn)$/i;

export function classifyMeetingSignals(
  signals: MeetingSignal[],
  options: { now?: () => number } = {},
): MeetingDetection[] {
  const now = options.now ?? (() => Date.now());
  const groups = new Map<string, ScoredSignal[]>();

  for (const signal of signals) {
    const scored = scoreSignal(signal);
    if (!scored) continue;

    const key = detectionKey(scored);
    const existing = groups.get(key);
    if (existing) {
      existing.push(scored);
    } else {
      groups.set(key, [scored]);
    }
  }

  return [...groups.entries()]
    .map(([id, group]) => buildDetection(id, group, now()))
    .sort((a, b) => b.confidence - a.confidence);
}

export class MeetingDetector {
  private timer: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<MeetingDetectionListener>();
  private candidateKey: string | undefined;
  private stableCount = 0;
  private activeMeeting: MeetingDetection | undefined;
  private missedCount = 0;

  constructor(
    private readonly provider: MeetingSignalProvider,
    private readonly options: MeetingDetectorOptions = {},
  ) {}

  on(listener: MeetingDetectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.timer) return;

    void this.detectOnce();
    this.timer = setInterval(() => {
      void this.detectOnce();
    }, this.options.pollIntervalMs ?? 1500);
  }

  stop(): void {
    if (!this.timer) return;

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async detectOnce(): Promise<MeetingDetectionEvent[]> {
    const signals = await this.provider.snapshot();
    const events = this.applyDetections(classifyMeetingSignals(signals, {
      now: this.options.now,
    }));

    for (const event of events) {
      this.emit(event);
    }

    return events;
  }

  private applyDetections(detections: MeetingDetection[]): MeetingDetectionEvent[] {
    const minConfidence = this.options.minConfidence ?? 0.7;
    const stableSnapshots = this.options.stableSnapshots ?? 2;
    const endedAfterMisses = this.options.endedAfterMisses ?? 2;
    const current = detections.find((detection) => detection.confidence >= minConfidence);

    if (!current) {
      this.candidateKey = undefined;
      this.stableCount = 0;

      if (!this.activeMeeting) {
        return [];
      }

      this.missedCount += 1;
      if (this.missedCount < endedAfterMisses) {
        return [];
      }

      const ended: MeetingDetection = {
        ...this.activeMeeting,
        state: 'ended',
        lastSeenAt: this.now(),
      };
      this.activeMeeting = undefined;
      this.missedCount = 0;
      return [{ type: 'meeting.ended', meeting: ended }];
    }

    this.missedCount = 0;

    if (this.activeMeeting?.id === current.id) {
      this.activeMeeting = {
        ...current,
        state: 'in_meeting',
        detectedAt: this.activeMeeting.detectedAt,
      };
      return [{ type: 'meeting.updated', meeting: this.activeMeeting }];
    }

    if (this.candidateKey === current.id) {
      this.stableCount += 1;
    } else {
      this.candidateKey = current.id;
      this.stableCount = 1;
    }

    if (this.stableCount < stableSnapshots) {
      return [{ type: 'meeting.candidate', meeting: current }];
    }

    this.activeMeeting = {
      ...current,
      state: 'in_meeting',
    };
    return [{ type: 'meeting.started', meeting: this.activeMeeting }];
  }

  private emit(event: MeetingDetectionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private now(): number {
    return (this.options.now ?? (() => Date.now()))();
  }
}

export function createStaticMeetingSignalProvider(
  signals: MeetingSignal[] | (() => MeetingSignal[] | Promise<MeetingSignal[]>),
): MeetingSignalProvider {
  return {
    async snapshot() {
      return typeof signals === 'function' ? signals() : signals;
    },
  };
}

function scoreSignal(signal: MeetingSignal): ScoredSignal | undefined {
  const urlScore = scoreUrl(signal);
  if (urlScore) return urlScore;

  const text = [
    signal.title,
    signal.appName,
    signal.processName,
    signal.sourceId,
  ]
    .filter(Boolean)
    .join(' ');

  const meetCode = text.match(GOOGLE_MEET_CODE_RE)?.[1]?.toLowerCase();
  if (meetCode) {
    return {
      platform: 'google-meet',
      confidence: signal.source === 'browser-tab' || signal.source === 'window' ? 0.82 : 0.72,
      meetingCode: meetCode,
      title: signal.title,
      appName: signal.appName,
      processName: signal.processName,
      sourceId: signal.sourceId,
      signal,
    };
  }

  if (/google meet/i.test(text)) {
    return {
      platform: 'google-meet',
      confidence: signal.isActive ? 0.7 : 0.55,
      title: signal.title,
      appName: signal.appName,
      processName: signal.processName,
      sourceId: signal.sourceId,
      signal,
    };
  }

  const zoomNumber = extractZoomMeetingNumber(text);
  if (/(^|\s)(zoom|zoom\.us)(\s|$)/i.test(text) || /zoom meeting|zoom webinar|personal meeting room/i.test(text)) {
    return {
      platform: 'zoom',
      confidence: zoomNumber ? 0.88 : signal.isActive ? 0.78 : 0.65,
      meetingCode: zoomNumber,
      title: signal.title,
      appName: signal.appName,
      processName: signal.processName,
      sourceId: signal.sourceId,
      signal,
    };
  }

  return undefined;
}

function scoreUrl(signal: MeetingSignal): ScoredSignal | undefined {
  if (!signal.url) return undefined;

  let url: URL;
  try {
    url = new URL(signal.url);
  } catch {
    return undefined;
  }

  if (url.hostname === 'meet.google.com') {
    const meetCode = url.pathname.match(GOOGLE_MEET_CODE_RE)?.[1]?.toLowerCase();
    return {
      platform: 'google-meet',
      confidence: meetCode ? 0.98 : 0.8,
      meetingCode: meetCode,
      meetingUrl: stripHash(signal.url),
      title: signal.title,
      appName: signal.appName,
      processName: signal.processName,
      sourceId: signal.sourceId,
      signal,
    };
  }

  if (ZOOM_HOST_RE.test(url.hostname)) {
    const pathParts = url.pathname.split('/').filter(Boolean);
    const meetingCode =
      pathParts[pathParts.findIndex((part) => part === 'j') + 1]?.replace(/\D/g, '') ||
      extractZoomMeetingNumber(url.pathname);

    if (meetingCode || pathParts.includes('wc') || pathParts.includes('my')) {
      return {
        platform: 'zoom',
        confidence: meetingCode ? 0.97 : 0.86,
        meetingCode,
        meetingUrl: stripHash(signal.url),
        title: signal.title,
        appName: signal.appName,
        processName: signal.processName,
        sourceId: signal.sourceId,
        signal,
      };
    }
  }

  return undefined;
}

function buildDetection(id: string, group: ScoredSignal[], timestamp: number): MeetingDetection {
  const best = group.reduce((winner, item) =>
    item.confidence > winner.confidence ? item : winner,
  );
  const combinedConfidence = Math.min(
    0.99,
    best.confidence + Math.max(0, group.length - 1) * 0.05,
  );

  return {
    id,
    platform: best.platform,
    state: 'candidate',
    confidence: combinedConfidence,
    signals: group.map((item) => item.signal),
    meetingCode: best.meetingCode,
    meetingUrl: best.meetingUrl,
    title: best.title,
    appName: best.appName,
    processName: best.processName,
    sourceId: best.sourceId,
    detectedAt: timestamp,
    lastSeenAt: timestamp,
  };
}

function detectionKey(scored: ScoredSignal): string {
  if (scored.meetingCode) {
    return `${scored.platform}:${scored.meetingCode.toLowerCase()}`;
  }

  if (scored.meetingUrl) {
    return `${scored.platform}:${stripHash(scored.meetingUrl).toLowerCase()}`;
  }

  if (scored.title) {
    return `${scored.platform}:${scored.title.toLowerCase()}`;
  }

  return `${scored.platform}:active`;
}

function stripHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

function extractZoomMeetingNumber(text: string): string | undefined {
  const direct = text.match(ZOOM_MEETING_NUMBER_RE)?.[1];
  if (direct) return direct;

  const spaced = text.match(/\b(?:zoom\s+)?meeting\s+([\d\s-]{9,})\b/i)?.[1];
  const normalized = spaced?.replace(/\D/g, '');
  return normalized && normalized.length >= 9 ? normalized : undefined;
}
