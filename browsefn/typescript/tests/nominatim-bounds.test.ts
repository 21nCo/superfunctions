import { afterEach, expect, it, vi } from 'vitest';
import { NominatimProvider, radiusViewboxes } from '../src/geo/providers/nominatim.js';
afterEach(() => vi.restoreAllMocks());
it('handles equator and high latitude scaling', () => {
  const equator = radiusViewboxes(0, 0, 1000)[0];
  expect(equator[0]).toBeCloseTo(-0.0089932, 7);
  expect(radiusViewboxes(60, 0, 1000)[0][2]).toBeCloseTo(equator[2]*2, 7);
});
it.each([90,-90,89.99,-89.99])('bounds polar cap %s', lat => {
  const [west,south,east,north] = radiusViewboxes(lat,30,10000)[0];
  expect([west,east]).toEqual([-180,180]);
  expect(south).toBeGreaterThanOrEqual(-90);
  expect(north).toBeLessThanOrEqual(90);
});
it.each([179.999,-179.999])('splits antimeridian %s', lng => {
  const boxes = radiusViewboxes(0,lng,1000);
  expect(boxes).toHaveLength(2);
  expect(boxes.reduce((sum,b) => sum+b[2]-b[0],0)).toBeCloseTo(0.0179864,7);
});
it('handles zero and global radii', () => {
  expect(radiusViewboxes(0,0,0)).toEqual([[0,0,0,0]]);
  expect(radiusViewboxes(0,0,30000000)).toEqual([[-180,-90,180,90]]);
});
it('queries both boxes and deduplicates', async () => {
  const fetchMock = vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>[{place_id:1,lat:'0',lon:'179.999'}]} as Response);
  const result = await new NominatimProvider({userAgent:'test'}).search({query:'cafe',center:{lat:0,lng:179.999},radius:1000});
  expect(result).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  for (const call of fetchMock.mock.calls) expect(new URL(String(call[0])).searchParams.get('bounded')).toBe('1');
});
it('forwards geocoding bounds and country without changing free-form queries', async () => {
  const fetchMock = vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>[]} as Response);
  await new NominatimProvider({userAgent:'test'}).geocode('Main Street', {
    bounds:{sw:{lat:10,lng:20},ne:{lat:11,lng:21}},components:{country:'us'},limit:3,
  });
  const params = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({q:'Main Street',viewbox:'20,10,21,11',bounded:'1',countrycodes:'us',limit:'3'});
});
it('maps locality and postcode into a valid structured address query', async () => {
  const fetchMock = vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>[]} as Response);
  await new NominatimProvider({userAgent:'test'}).geocode('10 Main Street', {components:{country:'us',locality:'Boston',postalCode:'02110'}});
  const params = new URL(String(fetchMock.mock.calls[0][0])).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({street:'10 Main Street',city:'Boston',postalcode:'02110',countrycodes:'us'});
  expect(params.has('q')).toBe(false);
});
it('splits geocode bounds crossing the antimeridian and caps deduplicated results', async () => {
  const fetchMock = vi.spyOn(globalThis,'fetch').mockResolvedValue({ok:true,json:async()=>[{place_id:1,lat:'0',lon:'179'},{place_id:2,lat:'0',lon:'-179'}]} as Response);
  const result = await new NominatimProvider({userAgent:'test'}).geocode('Cafe', {bounds:{sw:{lat:-1,lng:179},ne:{lat:1,lng:-179}},limit:1});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result).toHaveLength(1);
  expect(fetchMock.mock.calls.map(call=>new URL(String(call[0])).searchParams.get('viewbox'))).toEqual(['179,-1,180,1','-180,-1,-179,1']);
});
