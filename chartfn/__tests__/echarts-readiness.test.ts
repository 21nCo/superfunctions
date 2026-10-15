import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ init: vi.fn() }));
vi.mock('echarts', () => ({ init: mocks.init }));
import { echartsAdapter, _private } from '../src/adapters/echarts.js';
const spec = { type: 'bar' as const, data: { series: [{ values: [1,2] }] } };
beforeEach(() => mocks.init.mockReset());
it('disposes partially mounted charts and preserves the original error', () => {
  const instance = { setOption: vi.fn(() => { throw Error('invalid vendor option'); }), dispose: vi.fn(() => { throw Error('cleanup'); }) };
  mocks.init.mockReturnValue(instance);
  expect(() => echartsAdapter.mount({} as HTMLElement, spec)).toThrow('invalid vendor option');
  expect(instance.dispose).toHaveBeenCalledOnce();
});
it('remounts for theme changes and validates updates before mutating', () => {
  const old = { setOption: vi.fn(), dispose: vi.fn() };
  const next = { setOption: vi.fn(), dispose: vi.fn() };
  mocks.init.mockReturnValueOnce(old).mockReturnValueOnce(next);
  const handle = echartsAdapter.mount({} as HTMLElement, spec);
  handle.update({ ...spec, options: { theme: 'dark' } });
  expect(old.dispose).toHaveBeenCalledOnce();
  expect(mocks.init).toHaveBeenLastCalledWith({}, 'dark');
  expect(next.setOption).toHaveBeenCalledOnce();
  expect(() => handle.update({ ...spec, data: { series: [] } })).toThrow();
  expect(next.setOption).toHaveBeenCalledOnce();
});
it('uses mixed combo series and separates multiple pie series', () => {
  const combo = _private.buildOption({ ...spec, type: 'combo', data: { series: [{ values:[1] }, { values:[2], type:'area' }] } }) as any;
  expect(combo.series.map((s:any)=>s.type)).toEqual(['bar','line']);
  expect(combo.series[1].areaStyle).toEqual({});
  const pie = _private.buildOption({ ...spec, type: 'pie', data: { series: [{values:[1]}, {values:[2]}] } }) as any;
  expect(pie.series[0].center).not.toEqual(pie.series[1].center);
});
