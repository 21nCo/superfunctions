import { afterEach, expect, it, vi } from 'vitest';
import { DeliveryLease } from './delivery-lease.js';
afterEach(() => vi.useRealTimers());
it('aborts at the last confirmed deadline when renewal hangs', async () => {
  vi.useFakeTimers();
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), () => new Promise(() => {}), lost);
  await vi.advanceTimersByTimeAsync(91);
  expect(lease.controller.signal.aborted).toBe(true);
  expect(lost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('retries transient renewal failure and stops every timer on completion', async () => {
  vi.useFakeTimers();
  const renew = vi.fn<() => Promise<boolean>>().mockRejectedValueOnce(new Error('transport')).mockResolvedValue(true);
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), renew, lost);
  await vi.advanceTimersByTimeAsync(150);
  expect(lost).not.toHaveBeenCalled();
  expect(renew).toHaveBeenCalledTimes(5);
  lease.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it('immediately aborts a rejected receipt', async () => {
  vi.useFakeTimers();
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), async () => false, lost);
  await vi.advanceTimersByTimeAsync(30);
  expect(lease.controller.signal.aborted).toBe(true);
  expect(lost).toHaveBeenCalledTimes(1);
});

it('cannot revive an expired receipt after a late successful renewal reply', async () => {
  vi.useFakeTimers();
  let reply!: (owned: boolean) => void;
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), () => new Promise(resolve => { reply = resolve; }), lost);
  await vi.advanceTimersByTimeAsync(91);
  reply(true);
  await Promise.resolve();
  expect(lease.controller.signal.aborted).toBe(true);
  expect(lost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops renewing a returned callback but retains expiry observation until settlement', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const renew = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), renew, lost);
  await vi.advanceTimersByTimeAsync(30);
  lease.stopRenewal();
  await vi.advanceTimersByTimeAsync(89);
  expect(renew).toHaveBeenCalledTimes(1);
  expect(lost).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(lost).toHaveBeenCalledTimes(1);
  expect(lease.controller.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects an already expired claim synchronously before a handler microtask can run', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now() - 91, async () => true, lost);
  expect(lease.controller.signal.aborted).toBe(true);
  expect(lost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects renewal success past the confirmed deadline even before its overdue timer runs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let reply!: (owned: boolean) => void;
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), () => new Promise(resolve => { reply = resolve; }), lost);
  await vi.advanceTimersByTimeAsync(30);
  // A renewal promise microtask can run before an overdue timer after a blocked loop.
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    reply(true);
    await Promise.resolve();
    expect(lease.controller.signal.aborted).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { clock.mockRestore(); lease.stop(); }
});

it('does not issue a renewal when its callback runs after the confirmed deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const renew = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const lost = vi.fn();
  const lease = new DeliveryLease(90, performance.now(), renew, lost);
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    await vi.advanceTimersByTimeAsync(30);
    expect(renew).not.toHaveBeenCalled();
    expect(lease.controller.signal.aborted).toBe(true);
    expect(lost).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { clock.mockRestore(); lease.stop(); }
});
