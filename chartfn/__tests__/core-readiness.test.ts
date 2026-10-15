import { describe, expect, it, vi } from 'vitest';
import { chartFn } from '../src/chart-fn.js';
import { validateChartSpec } from '../src/validate.js';
const spec = { type: 'bar' as const, data: { series: [{ values: [1, 2] }] } };
describe('core readiness', () => {
  it.each([NaN, Infinity, -Infinity])('rejects nonfinite data %s', value => {
    expect(validateChartSpec({ ...spec, data: { series: [{ values: [value] }] } }).ok).toBe(false);
  });
  it.each([{ dimensions: [1] }, { labels: 'bad' }, { series: [{ name: 1, values: [1] }] }])('rejects malformed dimensions and series', data => {
    expect(validateChartSpec({ ...spec, data: { ...spec.data, ...data } }).ok).toBe(false);
  });
  it('returns an envelope for null specs without reading their type', () => {
    const api = chartFn({ defaultAdapter: 'none' });
    expect(api.render({} as HTMLElement, null as any)).toMatchObject({ ok: false, error: { code: 'SPEC_INVALID' } });
  });
  it('validates updates and makes custom adapter disposal idempotent', () => {
    const handle = { update: vi.fn(), dispose: vi.fn() };
    const api = chartFn({ defaultAdapter: 'mock', adapters: { mock: { name: 'mock', mount: () => handle } } });
    const result = api.render({} as HTMLElement, spec);
    if (!result.ok) throw Error('mount failed');
    expect(() => result.result.update({ ...spec, data: { series: [] } })).toThrow();
    expect(handle.update).not.toHaveBeenCalled();
    result.result.dispose(); result.result.dispose(); result.result.update(spec);
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(handle.update).not.toHaveBeenCalled();
  });
});
it('rejects sparse arrays that would become null in serialized data', () => {
  expect(validateChartSpec({ ...spec, data: { series: [{ values: new Array(2) }] } }).ok).toBe(false);
});
