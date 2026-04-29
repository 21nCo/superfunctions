import { describe, expect, it } from 'vitest';
import {
  MeetingDetector,
  classifyMeetingSignals,
  createStaticMeetingSignalProvider,
  type MeetingSignal,
} from '../src/meeting-detection.js';

describe('meeting detection', () => {
  it('classifies Google Meet browser tabs from URLs', () => {
    const detections = classifyMeetingSignals([
      {
        source: 'browser-tab',
        appName: 'Google Chrome',
        title: 'Team Sync - Google Meet',
        url: 'https://meet.google.com/abc-defg-hij',
        isActive: true,
      },
    ]);

    expect(detections).toHaveLength(1);
    expect(detections[0]!.platform).toBe('google-meet');
    expect(detections[0]!.meetingCode).toBe('abc-defg-hij');
    expect(detections[0]!.confidence).toBeGreaterThan(0.9);
  });

  it('classifies Zoom native app windows', () => {
    const detections = classifyMeetingSignals([
      {
        source: 'window',
        appName: 'zoom.us',
        processName: 'zoom.us',
        title: 'Zoom Meeting 123 456 7890',
        isActive: true,
      },
    ]);

    expect(detections).toHaveLength(1);
    expect(detections[0]!.platform).toBe('zoom');
    expect(detections[0]!.meetingCode).toBe('1234567890');
    expect(detections[0]!.confidence).toBeGreaterThan(0.8);
  });

  it('debounces meeting start and end events', async () => {
    let snapshot: MeetingSignal[] = [
      {
        source: 'browser-tab',
        title: 'Sprint Planning - Google Meet',
        url: 'https://meet.google.com/xyz-abcd-efg',
        isActive: true,
      },
    ];
    const detector = new MeetingDetector(createStaticMeetingSignalProvider(() => snapshot), {
      stableSnapshots: 2,
      endedAfterMisses: 2,
    });

    expect((await detector.detectOnce()).map((event) => event.type)).toEqual([
      'meeting.candidate',
    ]);
    expect((await detector.detectOnce()).map((event) => event.type)).toEqual([
      'meeting.started',
    ]);

    snapshot = [];
    expect(await detector.detectOnce()).toEqual([]);
    const ended = await detector.detectOnce();
    expect(ended.map((event) => event.type)).toEqual(['meeting.ended']);
    expect(ended[0]!.meeting.state).toBe('ended');
  });

  it('emits updates while the same meeting remains visible', async () => {
    const detector = new MeetingDetector(
      createStaticMeetingSignalProvider([
        {
          source: 'browser-tab',
          title: 'Daily - Google Meet',
          url: 'https://meet.google.com/aaa-bbbb-ccc',
          isActive: true,
        },
      ]),
      { stableSnapshots: 1 },
    );

    expect((await detector.detectOnce())[0]!.type).toBe('meeting.started');
    expect((await detector.detectOnce())[0]!.type).toBe('meeting.updated');
  });
});
