import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, it, vi } from 'vitest';
import { ArtifactStore } from '@probefn/storage';
import { attachBrowserEventCapture } from '../src/event-capture.js';
import { performPageAction } from '../src/actions.js';

async function fixture(run: (input: { page: import('playwright').Page; store: ArtifactStore; root: string }) => Promise<void>, hanging = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'probefn-action-settle-'));
  const server = createServer((request, response) => {
    if (request.url === '/slow') {
      if (!hanging) setTimeout(() => { response.writeHead(500); response.end('failed'); }, 80);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<button id="trigger" onclick="console.error(\'action failure\'); fetch(\'/slow\')">Submit order</button>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: import('playwright').Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as {port: number}).port}`);
    await run({ page, store: new ArtifactStore({ repoRoot: root }), root });
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

it.each([{ selector: '#trigger' }, { query: 'Submit order' }])('counts delayed network failures after $selector$query and awaited storage', async target => {
  await fixture(async ({ page, store, root }) => {
    const createSink = store.createEventSink.bind(store);
    vi.spyOn(store, 'createEventSink').mockImplementation((...args) => {
      const sink = createSink(...args);
      const append = sink.append.bind(sink);
      vi.spyOn(sink, 'append').mockImplementation(async event => {
        await new Promise(resolve => setTimeout(resolve, 100));
        return append(event);
      });
      return sink;
    });
    const capture = attachBrowserEventCapture({ page, artifactStore: store, runId: 'run' });
    try {
      const result = await performPageAction({ page, repoRoot: root, action: { kind: 'click', target },
        eventPaths: capture.sinkPaths, flushEvents: () => capture.flush(), networkIdleMs: 10, settleTimeoutMs: 2000 });
      expect(result.newConsoleErrors).toBe(1);
      expect(result.newNetworkFailures).toBe(1);
    } finally { capture.dispose(); await capture.flush(); }
  });
});

it('reports settlement uncertainty without retrying a performed action and detaches observers', async () => {
  await fixture(async ({ page, store, root }) => {
    const capture = attachBrowserEventCapture({ page, artifactStore: store, runId: 'run' });
    const emitter = page as unknown as { listenerCount(event: string): number };
    const before = emitter.listenerCount('request');
    try {
      await expect(performPageAction({ page, repoRoot: root, action: { kind: 'click', target: { selector: '#trigger' } },
        eventPaths: capture.sinkPaths, flushEvents: () => capture.flush(), networkIdleMs: 10, settleTimeoutMs: 50 })).rejects.toMatchObject({
          code: 'E_ACTION_SETTLE_TIMEOUT', retryable: false, details: { actionMayHaveExecuted: true },
        });
      expect(emitter.listenerCount('request')).toBe(before);
    } finally { capture.dispose(); await capture.flush(); }
  }, true);
});


it('returns the original target identity when the action removes that target', async () => {
  await fixture(async ({ page, store, root }) => {
    await page.setContent('<button id="remove" onclick="this.remove()">Remove item</button>');
    const capture = attachBrowserEventCapture({ page, artifactStore: store, runId: 'run' });
    try {
      const result = await performPageAction({ page, repoRoot: root, action: { kind: 'click', target: { selector: '#remove' } },
        eventPaths: capture.sinkPaths, flushEvents: () => capture.flush(), networkIdleMs: 0 });
      expect(result.action).toBe('click');
      expect(result.targetElementId).toBeTruthy();
      expect(await page.locator('#remove').count()).toBe(0);
    } finally { capture.dispose(); await capture.flush(); }
  });
});
