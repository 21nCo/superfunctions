/** Actual browser timing at the original 2,000-element target; not a device-independent SLA. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { platform, arch, cpus } from 'node:os';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../core/', import.meta.url));
const require = createRequire(root + 'package.json');
const { build } = require('esbuild');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const bundle = await build({ stdin: { contents: "import {Drawfn} from './src/index.ts';window.Drawfn=Drawfn;", resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife' });
const server = createServer((_, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<canvas width="1000" height="800"></canvas>'); });
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const frame = window.requestAnimationFrame.bind(window); const renderMs = [];
    window.requestAnimationFrame = callback => frame(time => { const start = performance.now(); try { callback(time); } finally { renderMs.push(performance.now() - start); } });
    const canvas = document.querySelector('canvas'); const drawing = new Drawfn({ canvas });
    const scene = drawing.getScene(); scene.elements = Array.from({ length: 2000 }, (_, i) => ({ id: `r${i}`, type: 'rectangle', x: (i % 50) * 19, y: Math.floor(i / 50) * 19, w: 15, h: 15, rotation: 0, stroke: 'black', fill: 'red', strokeWidth: 1, opacity: 1 }));
    const next = () => new Promise(resolve => frame(resolve));
    const start = performance.now(); drawing.load(scene); const loadMs = performance.now() - start;
    await next(); await next(); renderMs.length = 0;
    const rectangle = canvas.getBoundingClientRect(); const inputMs = [];
    const send = (type, x, y) => { const before = performance.now(); canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: rectangle.left + x, clientY: rectangle.top + y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true })); inputMs.push(performance.now() - before); };
    drawing.setTool('select'); send('pointerdown', 7, 7);
    for (let i = 1; i <= 60; i++) { send('pointermove', 7 + i, 7 + i); await next(); }
    send('pointerup', 67, 67); await next();
    const history = drawing.getHistoryState(); const moved = drawing.getElementById('r0');
    const summary = values => { const sorted = [...values].sort((a, b) => a - b); return { samples: values.length, medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], maxMs: sorted.at(-1) }; };
    drawing.destroy(); window.requestAnimationFrame = frame;
    return { elementCount: 2000, loadMs, input: summary(inputMs), rendering: summary(renderMs), history, moved: { x: moved.x, y: moved.y }, workload: '2,000 visible filled/stroked rectangles; one 60-move select drag, one scheduled render per move' };
  });
  assert.equal(result.history.depth, 1); assert.deepEqual(result.moved, { x: 60, y: 60 }); assert.equal(result.rendering.samples >= 60, true); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: await browser.version(), host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, ...result, pageErrors: errors }, null, 2));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
