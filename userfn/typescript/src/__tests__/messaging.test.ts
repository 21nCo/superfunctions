import { describe, it, expect, beforeEach } from 'vitest';
import { MessagingEngine } from '../core/messaging';
import { SegmentEvaluator } from '../core/segments';
import { Campaign } from '../types';

const CAMPAIGNS: Campaign[] = [
  {
    id: 'camp-1',
    enabled: true,
    kind: 'modal',
    content: { body: 'Hello' },
    triggers: [{ type: 'url_match', pattern: '/dashboard' }],
    priority: 10
  },
  {
    id: 'camp-2',
    enabled: true,
    kind: 'banner',
    content: { body: 'Welcome' },
    triggers: [{ type: 'event', pattern: 'login' }],
    priority: 5
  }
];

describe('MessagingEngine', () => {
  let engine: MessagingEngine;
  let segments: SegmentEvaluator;

  beforeEach(() => {
    segments = new SegmentEvaluator();
    engine = new MessagingEngine(segments);
    engine.setCampaigns(CAMPAIGNS);
  });

  it('matches url trigger', () => {
    const user = { id: 'u1', traits: {} };
    const eligible = engine.getEligibleMessages('url_match', '/dashboard/settings', user);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('camp-1');
  });

  it('matches event trigger', () => {
    const user = { id: 'u1', traits: {} };
    const eligible = engine.getEligibleMessages('event', 'login', user);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe('camp-2');
  });

  it('respects priority', () => {
    // Add a high priority campaign for login
    const highPrio: Campaign = {
      id: 'camp-3',
      enabled: true,
      kind: 'modal',
      content: { body: 'Urgent' },
      triggers: [{ type: 'event', pattern: 'login' }],
      priority: 100
    };
    engine.setCampaigns([...CAMPAIGNS, highPrio]);

    const user = { id: 'u1', traits: {} };
    const eligible = engine.getEligibleMessages('event', 'login', user);
    expect(eligible).toHaveLength(2);
    expect(eligible[0].id).toBe('camp-3'); // Higher priority first
  });

  it('ignores disabled campaigns', () => {
     const disabled: Campaign = { ...CAMPAIGNS[0], id: 'dis', enabled: false };
     engine.setCampaigns([disabled]);
     const user = { id: 'u1', traits: {} };
     const eligible = engine.getEligibleMessages('url_match', '/dashboard', user);
     expect(eligible).toHaveLength(0);
  });
});


describe('campaign cap parity', () => {
  it.each([
    [undefined, [1, 1, 1]], [{}, [1, 1, 1]],
    [{ global: 0 }, [0, 0, 0]], [{ global: 1 }, [1, 0, 0]], [{ global: 2 }, [1, 1, 0]],
  ] as Array<[Campaign['caps'], number[]]>)('uses an explicit maximum shown count for %j', (caps, expected) => {
    const engine = new MessagingEngine(new SegmentEvaluator());
    engine.setCampaigns([{ ...CAMPAIGNS[1], caps }]);
    const eligible = () => engine.getEligibleMessages('event', 'login', { id: 'u1', traits: {} }).length;
    engine.trackDelivery('camp-2', 'dismissed');
    engine.trackDelivery('camp-2', 'clicked');
    expect(eligible()).toBe(expected[0]);
    engine.trackDelivery('camp-2', 'shown'); expect(eligible()).toBe(expected[1]);
    engine.trackDelivery('camp-2', 'shown'); expect(eligible()).toBe(expected[2]);
  });
});
