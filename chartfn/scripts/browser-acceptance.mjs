import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'package.json'));
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const result = await build({ stdin: { contents: `export { chartFn } from './src/chart-fn.ts'; export { chartjsAdapter } from './src/adapters/chartjs.ts'; export { echartsAdapter } from './src/adapters/echarts.ts'; export { carbonAdapter } from './src/adapters/carbon.ts'; export { Chart } from 'chart.js'; export * as echarts from 'echarts';`, resolveDir: root }, bundle: true, format: 'iife', globalName: 'Charts', write: false, platform: 'browser' });
const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body></body></html>'); });
let browser;
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.addStyleTag({ content: readFileSync(require.resolve('@carbon/charts/styles.css'), 'utf8') });
  const checks = await page.evaluate(async () => {
    const { chartFn, chartjsAdapter, echartsAdapter, carbonAdapter, Chart, echarts } = Charts;
    let checks = 0;
    const assert = (condition, message) => { if (!condition) throw Error(message); checks++; };
    const spec = type => ({ type, data: { dimensions: ['A', 'B', 'C'], series: [{ name: 'First', values: [2, 4, 3] }, { name: 'Second', values: [3, 2, 5] }] }, passthrough: { chartjsOptions: { animation: false }, echartsOptions: { animation: false } } });
    for (const [name, adapter] of [['chartjs', chartjsAdapter], ['echarts', echartsAdapter]]) {
      const api = chartFn({ defaultAdapter: name, adapters: { [name]: adapter } });
      for (const type of ['bar', 'line', 'area', 'pie', 'donut', 'scatter', 'combo']) {
        const container = document.createElement('div'); container.style.cssText = 'width:600px;height:400px'; document.body.appendChild(container);
        const result = api.render(container, spec(type));
        assert(result.ok, `${name}/${type}: ${JSON.stringify(result.error)}`);
        await new Promise(resolve => requestAnimationFrame(resolve));
        assert(container.querySelectorAll('canvas').length > 0, `${name}/${type}: rendered canvas`);
        if (name === 'chartjs') {
          const vendor = Chart.getChart(container.querySelector('canvas'));
          assert(vendor.getDatasetMeta(0).data.length === 3, `${type}: actual vendor data points`);
          if (type === 'area') assert(vendor.isPluginEnabled('filler'), 'area filler plugin');
          if (type === 'scatter') assert(vendor.getDatasetMeta(0)._parsed[1].x === 1, 'scatter numeric X');
          if (type === 'pie' || type === 'donut') {
            result.result.update({ ...spec(type), options: { axes: { x: { type: 'linear' } } } });
            assert(vendor.getDatasetMeta(0)._parsed.every((value, index) => value === [2, 4, 3][index]), `${type}: linear-axis options preserve radial values`);
            assert(vendor.getDatasetMeta(0).data.every(arc => Number.isFinite(arc.circumference) && arc.circumference > 0), `${type}: nonempty finite arcs`);
          }
          if (type === 'combo') assert(vendor.getDatasetMeta(1).type === 'line', 'combo mixed series');
          result.result.update(spec('line'));
          assert(vendor.config.type === 'line', 'type update');
        } else {
          const vendor = echarts.getInstanceByDom(container);
          assert(vendor.getOption().series.length === 2, `${type}: actual vendor series`);
          result.result.update({ ...spec('line'), options: { theme: 'dark' } });
          assert(echarts.getInstanceByDom(container).getOption().series[0].type === 'line', 'theme/type update');
          const svg = await result.result.toImage({ format: 'svg', width: 320, height: 200 });
          assert(svg.startsWith('data:image/svg+xml'), 'SVG renderer export');
          const png = await result.result.toImage({ format: 'png', width: 320, height: 200 });
          const image = new Image(); image.src = png; await image.decode();
          assert(image.width === 320 && image.height === 200, 'export dimensions');
        }
        result.result.dispose(); result.result.dispose(); result.result.update(spec('bar'));
        assert(container.querySelectorAll('canvas').length === 0, 'disposal clears vendor canvas');
        container.remove();
      }
    }
    {
      const api = chartFn({ defaultAdapter: 'carbon', adapters: { carbon: carbonAdapter } });
      for (const type of ['bar', 'line', 'area', 'pie', 'donut', 'scatter', 'combo']) {
        const container = document.createElement('div'); container.style.cssText = 'width:600px;height:400px'; document.body.appendChild(container);
        const mounted = api.render(container, spec(type));
        assert(mounted.ok, `carbon/${type}: ${JSON.stringify(mounted.error)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
        const svg = container.querySelector('svg.layout-svg-wrapper');
        assert(svg && svg.querySelectorAll('path, rect, circle').length > 0, `carbon/${type}: actual SVG marks`);
        if (type === 'bar') assert(svg.querySelectorAll('path.bar').length === 6, 'carbon: both grouped bar datasets rendered');
        if (type === 'combo') assert(svg.querySelectorAll('path.bar').length === 3 && svg.querySelectorAll('path.line').length === 1, 'carbon: actual mixed bar/line layers');
        if (type === 'pie' || type === 'donut') assert(svg.querySelectorAll('path.slice').length === 6, `carbon/${type}: distinct slices for both series`);
        if (type === 'scatter') assert(svg.querySelectorAll('circle.dot').length === 6 && !svg.innerHTML.includes('NaN'), 'carbon: numeric scatter coordinates');
        const serialized = await mounted.result.toImage({ format: 'svg', width: 320, height: 200 });
        assert(serialized.startsWith('data:image/svg+xml'), `carbon/${type}: SVG export`);
        const exported = new DOMParser().parseFromString(decodeURIComponent(serialized.split(',')[1]), 'image/svg+xml');
        assert(!exported.querySelector('parsererror') && exported.documentElement.getAttribute('width') === '320', `carbon/${type}: valid sized SVG`);
        const png = await mounted.result.toImage({ format: 'png', width: 320, height: 200 });
        const image = new Image(); image.src = png; await image.decode();
        assert(image.width === 320 && image.height === 200, `carbon/${type}: PNG dimensions`);
        const pixels = document.createElement('canvas'); pixels.width = 320; pixels.height = 200;
        const ctx = pixels.getContext('2d'); ctx.drawImage(image, 0, 0);
        assert(ctx.getImageData(0, 0, 320, 200).data.some((value, index) => index % 4 === 3 && value > 0), `carbon/${type}: nonblank PNG`);
        mounted.result.update({ ...spec('line'), options: { theme: 'dark', axes: { x: { type: 'linear' } } } });
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(container.children.length === 1 && container.querySelector('svg'), `carbon/${type}: type/theme update`);
        mounted.result.dispose(); mounted.result.dispose(); mounted.result.update(spec('bar'));
        assert(container.children.length === 0, `carbon/${type}: cleanup`);
        container.remove();
      }
    }
    assert(!chartFn({ defaultAdapter: 'chartjs' }).render('[', spec('bar')).ok, 'invalid selector returns envelope');
    return checks;
  });
  if (errors.length) throw Error(errors.join('\n'));
  console.log(JSON.stringify({ browser: await browser.version(), checks, pageErrors: errors }));
} finally {
  try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}
