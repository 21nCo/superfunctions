import { afterEach, expect, it, vi } from 'vitest';
import { UserFnClient } from '../index';
const make = (options: object = {}) => new UserFnClient({ apiKey: 'unused', bootstrapFlags: { feature: 'value' }, exposures: { endpoint: 'https://watch.example/ingest', apiKey: 'key', app: 'app' }, ...options });
afterEach(() => { vi.unstubAllGlobals(); });
it('defaults to compatibility grants, validates patches atomically and preserves denial across reset', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const c = make(); expect(c.getConsent()).toEqual({ analytics: true, messaging: true, doNotTrack: false });
  expect(() => c.setConsent({ analytics: false, messaging: 'yes' as any })).toThrow(); expect(c.getConsent().analytics).toBe(true);
  for (const value of [0, 1, 'false', [], null]) expect(() => make({ consent: { analytics: value } })).toThrow();
  const accessor = { get analytics(): boolean { throw new Error('must not invoke'); } }; expect(() => c.setConsent(accessor)).toThrow('booleans');
  c.setConsent({ analytics: false }); c.reset(); expect(c.getFlag('feature')).toBe('value'); await c.flushExposures();
  expect(fetch).not.toHaveBeenCalled(); expect(c.getExposureStatus()).toMatchObject({ pending: 0, dropped: 0, discarded: 0 });
  c.setConsent({ analytics: true, doNotTrack: true }); expect(c.getConsent()).toEqual({ analytics: false, messaging: false, doNotTrack: true });
  c.setConsent({ doNotTrack: false }); c.getFlag('feature'); await c.flushExposures(); expect(fetch).toHaveBeenCalledTimes(1);
});
it('checks live DNT again before delivery and never replays a discarded queue after regrant', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const navigator = { doNotTrack: '0' }; vi.stubGlobal('navigator', navigator);
  const c = make(); c.getFlag('old'); navigator.doNotTrack = '1';
  await c.flushExposures(); expect(fetch).not.toHaveBeenCalled();
  expect(c.getConsent()).toEqual({ analytics: false, messaging: false, doNotTrack: true });
  expect(c.getExposureStatus()).toMatchObject({ pending: 0, discarded: 1, dropped: 0 });
  navigator.doNotTrack = '0'; await c.flushExposures(); expect(fetch).not.toHaveBeenCalled();
  c.getFlag('new'); await c.flushExposures(); expect(fetch).toHaveBeenCalledTimes(1);
});
it('discards a failed retained event and permits only newly captured events after regrant', async () => {
  const events: any[] = []; let status = 503;
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { events.push(JSON.parse(init.body)); return new Response(null, { status }); }));
  const c = make(); c.getFlag('old'); await expect(c.flushExposures()).rejects.toThrow('retained');
  c.setConsent({ analytics: false }); c.getFlag('denied'); c.setConsent({ analytics: true }); status = 202;
  await c.flushExposures(); c.getFlag('new'); await c.flushExposures();
  expect(events.map(batch => batch.map((event: any) => event.properties.flagKey))).toEqual([['old'], ['new']]);
  expect(c.getExposureStatus()).toMatchObject({ discarded: 1, dropped: 0, pending: 0 });
});
it('does not emit a stale framework snapshot across withdrawal and regrant', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const c = make(); const observation = c.observeFlag('feature'); const snapshot = observation.getSnapshot();
  c.setConsent({ analytics: false }); c.setConsent({ analytics: true }); observation.track(snapshot); await c.flushExposures(); expect(fetch).not.toHaveBeenCalled();
  c.identify('new'); observation.track(observation.getSnapshot()); await c.flushExposures(); expect(fetch).toHaveBeenCalledTimes(1);
});
it('gates messaging before eligibility and logging stubs while leaving explicit feedback available', async () => {
  const submit = vi.fn(async () => ({ accepted: true, id: 'receipt' })); const c = make({ consent: { analytics: false, messaging: false }, feedbackService: { submit } });
  const eligible = vi.spyOn((c as any).messaging, 'getEligibleMessages'); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  c.trigger('event', 'login'); c.track('event', { private: 'value' }); c.render('slot'); expect(eligible).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  await c.submitFeedback({ title: 'explicit', body: 'requested', category: 'general' }); expect(submit).toHaveBeenCalledTimes(1); log.mockRestore();
});

it('fences consent withdrawal and regrant during exposure serialization', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 202 })); vi.stubGlobal('fetch', fetch);
  const c = make();
  c.identify({ toJSON() { c.setConsent({ analytics: false }); c.setConsent({ analytics: true }); return 'person'; } } as any);
  expect(c.getFlag('feature')).toBe('value'); await c.flushExposures(); expect(fetch).not.toHaveBeenCalled();
  c.identify('person'); c.getFlag('feature'); await c.flushExposures(); expect(fetch).toHaveBeenCalledTimes(1);
});
it('honors the legacy window DNT signal even when an application clears its forwarded veto', () => {
  const browser = { doNotTrack: 'yes' }; vi.stubGlobal('window', browser);
  const c = make({ doNotTrack: true }); c.setConsent({ doNotTrack: false, analytics: true, messaging: true });
  expect(c.getConsent()).toEqual({ analytics: false, messaging: false, doNotTrack: true });
  browser.doNotTrack = '0'; expect(c.getConsent()).toEqual({ analytics: true, messaging: true, doNotTrack: false });
  expect(() => make({ doNotTrack: 'false' })).toThrow('booleans');
});
